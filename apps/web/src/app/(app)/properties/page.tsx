import Link from 'next/link';
import { getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { Flash, type Search } from '@/components/Flash';
import { PinPicker } from '@/components/PinPicker';
import { createProperty, deleteProperty } from '@/app/actions/portfolio';

const PAGE_SIZE = 200;

export default async function PropertiesPage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser();
  const sp = await searchParams;
  const clientFilter = sp.client && /^[0-9a-f-]{36}$/i.test(sp.client) ? sp.client : null;
  const page = Math.max(1, Number(sp.page) || 1);
  const sql = getSql();
  const clients = await sql`SELECT id, name FROM clients WHERE organization_id = ${user.organizationId} ORDER BY name`;
  const properties = await sql`
    SELECT p.id, p.name, p.address, p.city, p.state, p.zip, p.property_type, p.declared_value, p.geocode_source,
      c.name AS client_name, c.color, count(*) OVER()::int AS total
    FROM properties p JOIN clients c ON c.id = p.client_id
    WHERE p.organization_id = ${user.organizationId} ${clientFilter ? sql`AND p.client_id = ${clientFilter}` : sql``}
    ORDER BY c.name, p.name LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`;
  const total = properties[0]?.total ?? 0;
  const qs = (p: number) => `/properties?page=${p}${clientFilter ? `&client=${clientFilter}` : ''}`;

  return (
    <div className="page">
      <h1>Properties</h1>
      <Flash search={searchParams} />
      <div className="card">
        <h2>Add a property</h2>
        {clients.length === 0 ? (
          <p className="muted">
            Add a <Link href="/clients">client</Link> first. To add many properties at once, use{' '}
            <Link href="/import">Import</Link>.
          </p>
        ) : (
          <form action={createProperty}>
            <div className="grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
              <label>
                Client
                <select name="client_id" required defaultValue={clientFilter ?? ''}>
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
                Property name
                <input type="text" name="name" required />
              </label>
              <label>
                Street address
                <input type="text" name="address" />
              </label>
              <label>
                City
                <input type="text" name="city" />
              </label>
              <label>
                State
                <input type="text" name="state" maxLength={2} />
              </label>
              <label>
                ZIP
                <input type="text" name="zip" maxLength={10} />
              </label>
              <label>
                Property type
                <input type="text" name="property_type" placeholder="Office, warehouse…" />
              </label>
              <label>
                Declared value ($)
                <input type="text" name="declared_value" inputMode="decimal" />
              </label>
            </div>
            <p className="small muted">
              The address is located with the US Census geocoder. If it cannot be found, drop a pin instead.
            </p>
            <PinPicker />
            <div style={{ marginTop: 12 }}>
              <button type="submit">Add property</button>
            </div>
          </form>
        )}
      </div>

      <div className="card">
        <form className="row" style={{ marginBottom: 12 }}>
          <label>
            Filter by client
            <select name="client" defaultValue={clientFilter ?? ''}>
              <option value="">All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="secondary" style={{ alignSelf: 'flex-end' }}>
            Apply
          </button>
          <span className="muted" style={{ alignSelf: 'flex-end' }}>
            {total.toLocaleString()} propert{total === 1 ? 'y' : 'ies'}
          </span>
        </form>
        <table>
          <thead>
            <tr>
              <th>Property</th>
              <th>Client</th>
              <th>Address</th>
              <th>Type</th>
              <th>Declared value</th>
              <th>Located by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {properties.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>
                  <span className="swatch" style={{ background: p.color }} />
                  {p.client_name}
                </td>
                <td>{[p.address, p.city, p.state, p.zip].filter(Boolean).join(', ')}</td>
                <td>{p.property_type}</td>
                <td>{p.declared_value != null ? `$${Number(p.declared_value).toLocaleString()}` : ''}</td>
                <td>{p.geocode_source === 'manual' ? 'Pin' : 'Address'}</td>
                <td>
                  <form action={deleteProperty}>
                    <input type="hidden" name="id" value={p.id} />
                    <button type="submit" className="link">
                      Delete
                    </button>
                  </form>
                </td>
              </tr>
            ))}
            {properties.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No properties yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {total > PAGE_SIZE && (
          <div className="row" style={{ marginTop: 12 }}>
            {page > 1 && <Link href={qs(page - 1)}>← Previous</Link>}
            <span className="muted">
              Page {page} of {Math.ceil(total / PAGE_SIZE)}
            </span>
            {page * PAGE_SIZE < total && <Link href={qs(page + 1)}>Next →</Link>}
          </div>
        )}
      </div>
    </div>
  );
}
