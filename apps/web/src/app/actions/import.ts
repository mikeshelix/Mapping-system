'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import Papa from 'papaparse';
import { geocodeBatch, geocodeOneLine, type AddressRow, type GeocodeResult } from '@hazard/core';
import { flagActiveEvents, getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { back, isUuid, money, optional, str } from '@/lib/form';

const MAX_ROWS = 10_000;
const IMPORT_FIELDS = ['name', 'address', 'city', 'state', 'zip', 'property_type', 'declared_value'] as const;
type Field = (typeof IMPORT_FIELDS)[number];

interface Parsed {
  columns: string[];
  rows: Array<Record<string, string>>;
}

async function parseSpreadsheet(file: File): Promise<Parsed> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    const result = Papa.parse<Record<string, string>>(await file.text(), { header: true, skipEmptyLines: 'greedy' });
    return { columns: (result.meta.fields ?? []).filter(Boolean), rows: result.data };
  }
  if (lower.endsWith('.xlsx')) {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const sheet = workbook.worksheets[0];
    if (!sheet) return { columns: [], rows: [] };
    const columns: string[] = [];
    sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      columns[col - 1] = cell.text.trim() || `Column ${col}`;
    });
    const rows: Array<Record<string, string>> = [];
    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const record: Record<string, string> = {};
      let hasValue = false;
      columns.forEach((name, i) => {
        const text = row.getCell(i + 1).text?.trim() ?? '';
        record[name] = text;
        if (text) hasValue = true;
      });
      if (hasValue) rows.push(record);
    }
    return { columns: columns.filter(Boolean), rows };
  }
  throw new Error('Upload a .csv or .xlsx file. (Older .xls files need to be saved as .xlsx first.)');
}

export async function uploadImport(form: FormData): Promise<void> {
  const user = await requireUser();
  const clientId = str(form, 'client_id');
  const file = form.get('file');
  const sql = getSql();
  const [client] = isUuid(clientId)
    ? await sql`SELECT id FROM clients WHERE id = ${clientId} AND organization_id = ${user.organizationId}`
    : [];
  if (!client) back('/import', 'error', 'Choose which client these properties belong to.');
  if (!(file instanceof File) || file.size === 0) back('/import', 'error', 'Choose a file to upload.');

  let parsed: Parsed;
  try {
    parsed = await parseSpreadsheet(file);
  } catch (err) {
    back('/import', 'error', err instanceof Error ? err.message : 'That file could not be read.');
  }
  if (parsed.columns.length === 0 || parsed.rows.length === 0) back('/import', 'error', 'That file has no rows.');
  if (parsed.rows.length > MAX_ROWS) {
    back('/import', 'error', `That file has ${parsed.rows.length.toLocaleString()} rows. Split it into files of ${MAX_ROWS.toLocaleString()} or fewer.`);
  }

  const batchId = await sql.begin(async (tx) => {
    const [batch] = await tx`
      INSERT INTO import_batches (organization_id, client_id, filename, columns, created_by)
      VALUES (${user.organizationId}, ${clientId}, ${file.name}, ${parsed.columns}::text[], ${user.id}) RETURNING id`;
    for (let i = 0; i < parsed.rows.length; i += 1000) {
      const chunk = JSON.stringify(parsed.rows.slice(i, i + 1000));
      await tx`
        INSERT INTO import_rows (batch_id, row_number, data)
        SELECT ${batch!.id}, ${i} + r.ord::int, r.value
        FROM jsonb_array_elements(${chunk}::text::jsonb) WITH ORDINALITY AS r(value, ord)`;
    }
    return batch!.id as string;
  });
  redirect(`/import/${batchId}`);
}

async function loadBatch(batchId: string, orgId: string) {
  if (!isUuid(batchId)) return null;
  const [batch] = await getSql()`
    SELECT id, client_id, columns, status FROM import_batches WHERE id = ${batchId} AND organization_id = ${orgId}`;
  return batch ?? null;
}

interface RowUpdate {
  id: string;
  name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  property_type: string | null;
  declared_value: number | null;
  lon: number | null;
  lat: number | null;
  matched_address: string | null;
  geocode_status: 'matched' | 'failed';
  error: string | null;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const FAIL_REASONS: Record<string, string> = {
  No_Match: 'Address not found',
  Tie: 'Address matched more than one location',
  No_Response: 'Geocoder returned no result for this row',
};

/** Apply the column mapping, then geocode every row through the US Census Geocoder. */
export async function applyMapping(form: FormData): Promise<void> {
  const user = await requireUser();
  const batchId = str(form, 'batch_id');
  const batch = await loadBatch(batchId, user.organizationId);
  if (!batch || batch.status !== 'mapping') back('/import', 'error', 'That import is no longer waiting for column mapping.');
  const columns = batch.columns as string[];
  const mapping = {} as Record<Field, string | null>;
  for (const field of IMPORT_FIELDS) {
    const col = str(form, `map_${field}`);
    mapping[field] = columns.includes(col) ? col : null;
  }
  if (!mapping.address) back(`/import/${batchId}`, 'error', 'Choose which column holds the street address.');

  const sql = getSql();
  const rows = await sql`SELECT id, row_number, data FROM import_rows WHERE batch_id = ${batchId} ORDER BY row_number`;
  const pick = (data: Record<string, string>, field: Field) => {
    const col = mapping[field];
    const value = col ? String(data[col] ?? '').trim() : '';
    return value || null;
  };

  const updates: RowUpdate[] = rows.map((r) => {
    const data = r.data as Record<string, string>;
    const address = pick(data, 'address');
    return {
      id: r.id,
      name: pick(data, 'name') ?? address ?? `Row ${r.row_number}`,
      address,
      city: pick(data, 'city'),
      state: pick(data, 'state'),
      zip: pick(data, 'zip'),
      property_type: pick(data, 'property_type'),
      declared_value: money(pick(data, 'declared_value')),
      lon: null,
      lat: null,
      matched_address: null,
      geocode_status: 'failed',
      error: address ? null : 'No address in this row',
    };
  });

  const apply = (u: RowUpdate, g: Omit<GeocodeResult, 'id'>) => {
    if (g.matched) {
      u.lon = g.lon;
      u.lat = g.lat;
      u.matched_address = g.matchedAddress;
      u.geocode_status = 'matched';
      u.error = null;
    } else {
      u.error = FAIL_REASONS[g.detail] ?? g.detail;
    }
  };

  // Rows with separate city / state / ZIP go through the batch service; rows with a
  // single full-address column go one at a time through the one-line service.
  const withAddress = updates.filter((u) => u.address);
  const structured = withAddress.filter((u) => u.city || u.state || u.zip);
  const oneLine = withAddress.filter((u) => !(u.city || u.state || u.zip));
  const byId = new Map(updates.map((u) => [u.id, u]));

  if (structured.length) {
    try {
      const input: AddressRow[] = structured.map((u) => ({ id: u.id, street: u.address!, city: u.city, state: u.state, zip: u.zip }));
      for (const g of await geocodeBatch(input)) {
        const u = byId.get(g.id);
        if (u) apply(u, g);
      }
    } catch {
      for (const u of structured) u.error = 'The Census geocoder did not respond. Use "Retry failed rows".';
    }
  }
  await mapWithConcurrency(oneLine, 5, async (u) => {
    try {
      apply(u, await geocodeOneLine(u.address!));
    } catch {
      u.error = 'The Census geocoder did not respond. Use "Retry failed rows".';
    }
  });

  await sql.begin(async (tx) => {
    for (let i = 0; i < updates.length; i += 1000) {
      await tx`
        UPDATE import_rows r SET name = x.name, address = x.address, city = x.city, state = x.state, zip = x.zip,
          property_type = x.property_type, declared_value = x.declared_value, lon = x.lon, lat = x.lat,
          matched_address = x.matched_address, geocode_status = x.geocode_status, error = x.error
        FROM jsonb_to_recordset(${JSON.stringify(updates.slice(i, i + 1000))}::text::jsonb) AS x(
          id uuid, name text, address text, city text, state text, zip text, property_type text,
          declared_value numeric, lon float8, lat float8, matched_address text, geocode_status text, error text)
        WHERE r.id = x.id AND r.batch_id = ${batchId}`;
    }
    await tx`UPDATE import_batches SET status = 'review', mapping = ${JSON.stringify(mapping)}::text::jsonb WHERE id = ${batchId}`;
  });
  redirect(`/import/${batchId}`);
}

async function loadRow(rowId: string, orgId: string) {
  if (!isUuid(rowId)) return null;
  const [row] = await getSql()`
    SELECT r.id, r.batch_id, b.status FROM import_rows r JOIN import_batches b ON b.id = r.batch_id
    WHERE r.id = ${rowId} AND b.organization_id = ${orgId}`;
  return row && row.status === 'review' ? row : null;
}

/** Correct a failed row's address and look it up again. */
export async function retryImportRow(form: FormData): Promise<void> {
  const user = await requireUser();
  const row = await loadRow(str(form, 'row_id'), user.organizationId);
  if (!row) back('/import', 'error', 'That row can no longer be edited.');
  const address = optional(form, 'address');
  const city = optional(form, 'city');
  const state = optional(form, 'state');
  const zip = optional(form, 'zip');
  const path = `/import/${row.batch_id}`;
  if (!address) back(path, 'error', 'Enter a street address to retry.');
  const oneLine = [address, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  let result: Omit<GeocodeResult, 'id'> | null = null;
  try {
    result = await geocodeOneLine(oneLine);
  } catch {
    result = null;
  }
  const sql = getSql();
  if (result?.matched) {
    await sql`
      UPDATE import_rows SET address = ${address}, city = ${city}, state = ${state}, zip = ${zip}, lon = ${result.lon},
        lat = ${result.lat}, matched_address = ${result.matchedAddress}, geocode_status = 'matched', error = NULL
      WHERE id = ${row.id}`;
    revalidatePath(path);
    back(path, 'notice', `Found: ${result.matchedAddress}`);
  }
  await sql`
    UPDATE import_rows SET address = ${address}, city = ${city}, state = ${state}, zip = ${zip},
      error = ${result ? 'Address not found' : 'The Census geocoder did not respond'}
    WHERE id = ${row.id}`;
  revalidatePath(path);
  back(path, 'error', `Still no match for "${oneLine}". Correct it again or set a pin.`);
}

/** Retry every failed row that has an address (for geocoder outages). */
export async function retryFailedRows(form: FormData): Promise<void> {
  const user = await requireUser();
  const batchId = str(form, 'batch_id');
  const batch = await loadBatch(batchId, user.organizationId);
  if (!batch || batch.status !== 'review') back('/import', 'error', 'That import is not in review.');
  const sql = getSql();
  const rows = await sql`
    SELECT id, address, city, state, zip FROM import_rows
    WHERE batch_id = ${batchId} AND geocode_status = 'failed' AND address IS NOT NULL`;
  let found = 0;
  await mapWithConcurrency([...rows], 5, async (r) => {
    try {
      const oneLine = [r.address, r.city, [r.state, r.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      const g = await geocodeOneLine(oneLine);
      if (g.matched) {
        found++;
        await sql`
          UPDATE import_rows SET lon = ${g.lon}, lat = ${g.lat}, matched_address = ${g.matchedAddress},
            geocode_status = 'matched', error = NULL WHERE id = ${r.id}`;
      } else {
        await sql`UPDATE import_rows SET error = 'Address not found' WHERE id = ${r.id}`;
      }
    } catch {
      /* leave the row failed */
    }
  });
  revalidatePath(`/import/${batchId}`);
  back(`/import/${batchId}`, 'notice', `Retried ${rows.length} row(s); ${found} now located.`);
}

export async function setImportPin(form: FormData): Promise<void> {
  const user = await requireUser();
  const row = await loadRow(str(form, 'row_id'), user.organizationId);
  if (!row) back('/import', 'error', 'That row can no longer be edited.');
  const lon = Number(str(form, 'lon'));
  const lat = Number(str(form, 'lat'));
  const path = `/import/${row.batch_id}`;
  if (!str(form, 'lon') || !str(form, 'lat') || !(Math.abs(lon) <= 180) || !(Math.abs(lat) <= 90)) {
    back(`${path}/pin/${row.id}`, 'error', 'Click the map to place the pin first.');
  }
  await getSql()`
    UPDATE import_rows SET lon = ${lon}, lat = ${lat}, geocode_status = 'manual', error = NULL, matched_address = NULL
    WHERE id = ${row.id}`;
  revalidatePath(path);
  back(path, 'notice', 'Pin saved.');
}

/** Save every located row as a property. Rows that are still failed are left out. */
export async function commitImport(form: FormData): Promise<void> {
  const user = await requireUser();
  const batchId = str(form, 'batch_id');
  const batch = await loadBatch(batchId, user.organizationId);
  if (!batch || batch.status !== 'review') back('/import', 'error', 'That import is not in review.');
  const sql = getSql();
  const saved = await sql.begin(async (tx) => {
    const rows = await tx`
      INSERT INTO properties (organization_id, client_id, name, address, city, state, zip, location, geocode_source,
        matched_address, property_type, declared_value)
      SELECT ${user.organizationId}, ${batch.client_id}, COALESCE(r.name, r.address, 'Row ' || r.row_number), r.address,
        r.city, r.state, r.zip, ST_SetSRID(ST_MakePoint(r.lon, r.lat), 4326),
        CASE r.geocode_status WHEN 'manual' THEN 'manual' ELSE 'census' END, r.matched_address, r.property_type, r.declared_value
      FROM import_rows r
      WHERE r.batch_id = ${batchId} AND r.geocode_status IN ('matched', 'manual') AND r.lon IS NOT NULL AND r.lat IS NOT NULL
      RETURNING id`;
    await tx`UPDATE import_batches SET status = 'committed' WHERE id = ${batchId}`;
    return rows.length;
  });
  // Newly added properties may sit inside hazards already in effect.
  await flagActiveEvents(sql);
  revalidatePath('/properties');
  back(`/import/${batchId}`, 'notice', `Saved ${saved.toLocaleString()} propert${saved === 1 ? 'y' : 'ies'}.`);
}

export async function discardImport(form: FormData): Promise<void> {
  const user = await requireUser();
  const batchId = str(form, 'batch_id');
  if (!isUuid(batchId)) return;
  await getSql()`
    UPDATE import_batches SET status = 'discarded'
    WHERE id = ${batchId} AND organization_id = ${user.organizationId} AND status IN ('mapping', 'review')`;
  back('/import', 'notice', 'Import discarded. Nothing was saved.');
}
