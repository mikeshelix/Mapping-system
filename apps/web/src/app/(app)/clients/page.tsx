import { getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { Flash, type Search } from '@/components/Flash';
import { createClientAction, deleteClient, updateClientColor } from '@/app/actions/portfolio';

export default async function ClientsPage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser();
  const clients = await getSql()`
    SELECT c.id, c.name, c.color,
      (SELECT count(*)::int FROM properties p WHERE p.client_id = c.id) AS properties,
      (SELECT count(*)::int FROM contacts k WHERE k.client_id = c.id) AS contacts
    FROM clients c WHERE c.organization_id = ${user.organizationId} ORDER BY c.name`;

  return (
    <div className="page">
      <h1>Clients</h1>
      <Flash search={searchParams} />
      <div className="card">
        <h2>Add a client</h2>
        <form action={createClientAction} className="row">
          <label>
            Name
            <input type="text" name="name" required />
          </label>
          <label>
            Map color
            <input type="color" name="color" defaultValue="#2563eb" />
          </label>
          <button type="submit" style={{ alignSelf: 'flex-end' }}>
            Add client
          </button>
        </form>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Color</th>
              <th>Properties</th>
              <th>Contacts</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id}>
                <td>
                  <span className="swatch" style={{ background: c.color }} />
                  {c.name}
                </td>
                <td>
                  <form action={updateClientColor} className="row">
                    <input type="hidden" name="id" value={c.id} />
                    <input type="color" name="color" defaultValue={c.color} />
                    <button type="submit" className="secondary">
                      Save
                    </button>
                  </form>
                </td>
                <td>{c.properties}</td>
                <td>{c.contacts}</td>
                <td>
                  <form action={deleteClient}>
                    <input type="hidden" name="id" value={c.id} />
                    <button type="submit" className="link" title="Also removes this client's properties and contacts">
                      Delete
                    </button>
                  </form>
                </td>
              </tr>
            ))}
            {clients.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No clients yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
