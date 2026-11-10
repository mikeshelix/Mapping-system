import Link from 'next/link';
import { getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { Flash, when, type Search } from '@/components/Flash';
import { uploadImport } from '@/app/actions/import';

const STATUS: Record<string, string> = {
  mapping: 'Waiting for column mapping',
  review: 'Waiting for review',
  committed: 'Saved',
  discarded: 'Discarded',
};

export default async function ImportPage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser();
  const sql = getSql();
  const clients = await sql`SELECT id, name FROM clients WHERE organization_id = ${user.organizationId} ORDER BY name`;
  const batches = await sql`
    SELECT b.id, b.filename, b.status, b.created_at, c.name AS client_name,
      (SELECT count(*)::int FROM import_rows r WHERE r.batch_id = b.id) AS rows
    FROM import_batches b JOIN clients c ON c.id = b.client_id
    WHERE b.organization_id = ${user.organizationId} ORDER BY b.created_at DESC LIMIT 25`;

  return (
    <div className="page">
      <h1>Import properties</h1>
      <Flash search={searchParams} />
      <div className="card">
        {clients.length === 0 ? (
          <p className="muted">
            Add a <Link href="/clients">client</Link> first; every imported property belongs to one.
          </p>
        ) : (
          <form action={uploadImport} className="grid">
            <label>
              Client
              <select name="client_id" required defaultValue="">
                <option value="" disabled>
                  Choose…
                </option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Spreadsheet (.csv or .xlsx)
              <input type="file" name="file" accept=".csv,.xlsx,.txt" required />
            </label>
            <button type="submit">Upload</button>
          </form>
        )}
        <p className="small muted">
          The first row must hold column headings. Next you choose which columns hold the address, then every address
          is located with the US Census geocoder and you review the results before anything is saved. Up to 10,000 rows
          per file; large files can take a few minutes to locate.
        </p>
      </div>
      {batches.length > 0 && (
        <div className="card">
          <h2>Recent imports</h2>
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Client</th>
                <th>Rows</th>
                <th>Uploaded</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>{b.status === 'discarded' ? b.filename : <Link href={`/import/${b.id}`}>{b.filename}</Link>}</td>
                  <td>{b.client_name}</td>
                  <td>{b.rows.toLocaleString()}</td>
                  <td>{when(b.created_at)}</td>
                  <td>{STATUS[b.status] ?? b.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
