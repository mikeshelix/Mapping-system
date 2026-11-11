import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { isUuid } from '@/lib/form';
import { Flash, type Search } from '@/components/Flash';
import { SubmitButton } from '@/components/SubmitButton';
import { applyMapping, commitImport, discardImport, retryFailedRows, retryImportRow } from '@/app/actions/import';

const FIELDS: Array<{ key: string; label: string; guess: RegExp; required?: boolean }> = [
  { key: 'address', label: 'Street address', guess: /^(street|address|addr|address ?1|street address|location)/i, required: true },
  { key: 'city', label: 'City', guess: /city|town/i },
  { key: 'state', label: 'State', guess: /^(state|st)$|state/i },
  { key: 'zip', label: 'ZIP code', guess: /zip|postal/i },
  { key: 'name', label: 'Property name', guess: /name|property|site|building/i },
  { key: 'property_type', label: 'Property type', guess: /type|use|occupancy/i },
  { key: 'declared_value', label: 'Declared value', guess: /value|tiv|insured|amount/i },
];

export default async function ImportBatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Search;
}) {
  const user = await requireUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const sql = getSql();
  const [batch] = await sql`
    SELECT b.id, b.filename, b.columns, b.status, c.name AS client_name
    FROM import_batches b JOIN clients c ON c.id = b.client_id
    WHERE b.id = ${id} AND b.organization_id = ${user.organizationId}`;
  if (!batch || batch.status === 'discarded') notFound();
  const columns = batch.columns as string[];

  const header = (
    <>
      <h1>
        {batch.filename} <span className="muted">→ {batch.client_name}</span>
      </h1>
      <Flash search={searchParams} />
    </>
  );

  if (batch.status === 'mapping') {
    const sample = await sql`SELECT data FROM import_rows WHERE batch_id = ${id} ORDER BY row_number LIMIT 3`;
    const [{ count }] = (await sql`SELECT count(*)::int AS count FROM import_rows WHERE batch_id = ${id}`) as unknown as [
      { count: number },
    ];
    const used = new Set<string>();
    const guesses = Object.fromEntries(
      FIELDS.map((f) => {
        const hit = columns.find((c) => !used.has(c) && f.guess.test(c.trim()));
        if (hit) used.add(hit);
        return [f.key, hit ?? ''];
      }),
    );
    return (
      <div className="page">
        {header}
        <div className="card">
          <h2>Step 1 of 2: match your columns</h2>
          <p className="muted">
            {count.toLocaleString()} rows found. Tell us which column holds each piece of information. Only the street
            address is required; if one column holds the whole address, choose it for street address and leave city,
            state and ZIP unmatched.
          </p>
          <form action={applyMapping}>
            <input type="hidden" name="batch_id" value={batch.id} />
            <table>
              <thead>
                <tr>
                  <th>We need</th>
                  <th>Your column</th>
                  <th>First rows</th>
                </tr>
              </thead>
              <tbody>
                {FIELDS.map((f) => (
                  <tr key={f.key}>
                    <td>
                      {f.label}
                      {f.required && ' *'}
                    </td>
                    <td>
                      <select name={`map_${f.key}`} defaultValue={guesses[f.key]} required={f.required}>
                        <option value="">Not in this file</option>
                        {columns.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="muted small">
                      {guesses[f.key]
                        ? sample.map((s) => (s.data as Record<string, string>)[guesses[f.key]!]).filter(Boolean).join(' · ')
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ marginTop: 12 }}>
              <SubmitButton pendingLabel="Locating addresses… this can take a few minutes">Locate addresses</SubmitButton>
            </div>
          </form>
          <form action={discardImport} style={{ marginTop: 8 }}>
            <input type="hidden" name="batch_id" value={batch.id} />
            <button type="submit" className="link">
              Discard this import
            </button>
          </form>
        </div>
      </div>
    );
  }

  const [stats] = await sql`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE geocode_status = 'matched')::int AS matched,
      count(*) FILTER (WHERE geocode_status = 'manual')::int AS manual,
      count(*) FILTER (WHERE geocode_status = 'failed')::int AS failed
    FROM import_rows WHERE batch_id = ${id}`;
  const s = stats!;

  if (batch.status === 'committed') {
    return (
      <div className="page">
        {header}
        <div className="card">
          <p>
            This import is saved: {(s.matched + s.manual).toLocaleString()} properties added
            {s.failed > 0 && `, ${s.failed.toLocaleString()} rows left out because they could not be located`}.
          </p>
          <Link href="/properties">View properties</Link> · <Link href="/">Open the map</Link>
        </div>
      </div>
    );
  }

  const failed = await sql`
    SELECT id, row_number, name, address, city, state, zip, error FROM import_rows
    WHERE batch_id = ${id} AND geocode_status = 'failed' ORDER BY row_number LIMIT 500`;
  const located = await sql`
    SELECT id, row_number, name, address, city, state, zip, matched_address, geocode_status, lon, lat, declared_value FROM import_rows
    WHERE batch_id = ${id} AND geocode_status IN ('matched', 'manual') ORDER BY (geocode_status = 'manual') DESC, row_number LIMIT 200`;
  const ready = s.matched + s.manual;

  return (
    <div className="page">
      {header}
      <div className="card">
        <h2>Step 2 of 2: review before saving</h2>
        <div className="stats" style={{ marginBottom: 12 }}>
          <div>
            <strong>{s.total.toLocaleString()}</strong>rows
          </div>
          <div>
            <strong>{s.matched.toLocaleString()}</strong>located by address
          </div>
          <div>
            <strong>{s.manual.toLocaleString()}</strong>placed by pin
          </div>
          <div>
            <strong style={{ color: s.failed ? 'var(--danger)' : undefined }}>{s.failed.toLocaleString()}</strong>not located
          </div>
        </div>
        <p className="muted">
          Nothing is saved until you press Save. Rows that are still not located are left out; fix them below first, or
          add them later.
        </p>
        <div className="row">
          <form action={commitImport}>
            <input type="hidden" name="batch_id" value={batch.id} />
            <SubmitButton pendingLabel="Saving…" disabled={ready === 0}>
              Save {ready.toLocaleString()} propert{ready === 1 ? 'y' : 'ies'}
              {s.failed > 0 ? ` (skip ${s.failed.toLocaleString()} not located)` : ''}
            </SubmitButton>
          </form>
          {s.failed > 0 && (
            <form action={retryFailedRows}>
              <input type="hidden" name="batch_id" value={batch.id} />
              <SubmitButton pendingLabel="Retrying…" secondary>
                Retry failed rows
              </SubmitButton>
            </form>
          )}
          <form action={discardImport}>
            <input type="hidden" name="batch_id" value={batch.id} />
            <button type="submit" className="link">
              Discard this import
            </button>
          </form>
        </div>
      </div>

      {failed.length > 0 && (
        <div className="card">
          <h2>
            Not located ({s.failed.toLocaleString()}
            {s.failed > failed.length ? `, showing first ${failed.length}` : ''})
          </h2>
          <table>
            <thead>
              <tr>
                <th>Row</th>
                <th>Property</th>
                <th>Correct the address and retry, or set a pin</th>
                <th>Problem</th>
              </tr>
            </thead>
            <tbody>
              {failed.map((r) => (
                <tr key={r.id} className="bad">
                  <td>{r.row_number}</td>
                  <td>{r.name}</td>
                  <td>
                    <form action={retryImportRow} className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
                      <input type="hidden" name="row_id" value={r.id} />
                      <input type="text" name="address" defaultValue={r.address ?? ''} placeholder="Street" aria-label="Street" />
                      <input type="text" name="city" defaultValue={r.city ?? ''} placeholder="City" aria-label="City" style={{ width: 120 }} />
                      <input type="text" name="state" defaultValue={r.state ?? ''} placeholder="ST" aria-label="State" style={{ width: 50 }} />
                      <input type="text" name="zip" defaultValue={r.zip ?? ''} placeholder="ZIP" aria-label="ZIP" style={{ width: 80 }} />
                      <button type="submit" className="secondary">
                        Retry
                      </button>
                      <Link className="button secondary" href={`/import/${batch.id}/pin/${r.id}`}>
                        Set pin
                      </Link>
                    </form>
                  </td>
                  <td>{r.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>
          Located ({ready.toLocaleString()}
          {ready > located.length ? `, showing first ${located.length}` : ''})
        </h2>
        <table>
          <thead>
            <tr>
              <th>Row</th>
              <th>Property</th>
              <th>Your address</th>
              <th>Located at</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {located.map((r) => (
              <tr key={r.id}>
                <td>{r.row_number}</td>
                <td>{r.name}</td>
                <td>{[r.address, r.city, r.state, r.zip].filter(Boolean).join(', ')}</td>
                <td>
                  {r.geocode_status === 'manual'
                    ? `Pin at ${Number(r.lat).toFixed(5)}, ${Number(r.lon).toFixed(5)}`
                    : r.matched_address}{' '}
                  <Link className="small" href={`/import/${batch.id}/pin/${r.id}`}>
                    adjust
                  </Link>
                </td>
                <td>{r.declared_value != null ? `$${Number(r.declared_value).toLocaleString()}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
