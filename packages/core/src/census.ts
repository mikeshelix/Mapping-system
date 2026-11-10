/**
 * US Census Geocoder client (free, no key).
 * Docs: https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html
 * Covers the United States, Puerto Rico and the US Island Areas only.
 */
const BASE = 'https://geocoding.geo.census.gov/geocoder';
const BENCHMARK = 'Public_AR_Current';
/** The service allows 10,000 rows per file; smaller files return faster and fail smaller. */
export const CENSUS_BATCH_SIZE = 1000;

export interface AddressRow {
  id: string;
  street: string;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

export interface GeocodeResult {
  id: string;
  matched: boolean;
  lon: number | null;
  lat: number | null;
  matchedAddress: string | null;
  /** "Exact" or "Non_Exact" for matches; "No_Match" or "Tie" otherwise. */
  detail: string;
}

function csvField(value: string): string {
  return `"${value.replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
}

export function buildBatchCsv(rows: AddressRow[]): string {
  return rows
    .map((r) => [r.id, r.street, r.city ?? '', r.state ?? '', r.zip ?? ''].map((v) => csvField(String(v))).join(','))
    .join('\n');
}

/** Minimal RFC 4180 parser: handles quoted fields, escaped quotes and embedded commas. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

/**
 * Batch response columns:
 *   id, input address, "Match"|"No_Match"|"Tie", "Exact"|"Non_Exact", matched address, "lon,lat", tiger line id, side
 */
export function parseBatchResponse(text: string): GeocodeResult[] {
  return parseCsv(text).map((cols) => {
    const id = cols[0] ?? '';
    const status = cols[2] ?? 'No_Match';
    const [lonStr, latStr] = (cols[5] ?? '').split(',');
    const lon = Number(lonStr);
    const lat = Number(latStr);
    const matched = status === 'Match' && Number.isFinite(lon) && Number.isFinite(lat) && !!lonStr && !!latStr;
    return {
      id,
      matched,
      lon: matched ? lon : null,
      lat: matched ? lat : null,
      matchedAddress: matched ? (cols[4] ?? null) : null,
      detail: matched ? (cols[3] ?? 'Match') : status,
    };
  });
}

export async function geocodeBatch(rows: AddressRow[], fetchImpl: typeof fetch = fetch): Promise<GeocodeResult[]> {
  const results = new Map<string, GeocodeResult>();
  for (let i = 0; i < rows.length; i += CENSUS_BATCH_SIZE) {
    const chunk = rows.slice(i, i + CENSUS_BATCH_SIZE);
    const form = new FormData();
    form.append('addressFile', new Blob([buildBatchCsv(chunk)], { type: 'text/csv' }), 'addresses.csv');
    form.append('benchmark', BENCHMARK);
    const res = await fetchImpl(`${BASE}/locations/addressbatch`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`Census geocoder returned HTTP ${res.status}`);
    for (const r of parseBatchResponse(await res.text())) results.set(r.id, r);
  }
  // Any row the service silently dropped is reported as unmatched rather than lost.
  return rows.map(
    (r) =>
      results.get(r.id) ?? { id: r.id, matched: false, lon: null, lat: null, matchedAddress: null, detail: 'No_Response' },
  );
}

export async function geocodeOneLine(
  address: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Omit<GeocodeResult, 'id'>> {
  const url = `${BASE}/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=${BENCHMARK}&format=json`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Census geocoder returned HTTP ${res.status}`);
  const json = (await res.json()) as {
    result?: { addressMatches?: Array<{ coordinates: { x: number; y: number }; matchedAddress: string }> };
  };
  const match = json.result?.addressMatches?.[0];
  if (!match) return { matched: false, lon: null, lat: null, matchedAddress: null, detail: 'No_Match' };
  return {
    matched: true,
    lon: match.coordinates.x,
    lat: match.coordinates.y,
    matchedAddress: match.matchedAddress,
    detail: 'Match',
  };
}
