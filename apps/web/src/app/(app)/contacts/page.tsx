import Link from 'next/link';
import { getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { Flash, type Search } from '@/components/Flash';
import { createContact, deleteContact } from '@/app/actions/portfolio';

export default async function ContactsPage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser();
  const sql = getSql();
  const clients = await sql`SELECT id, name FROM clients WHERE organization_id = ${user.organizationId} ORDER BY name`;
  const contacts = await sql`
    SELECT k.id, k.name, k.email, k.mobile, k.sms_opt_in, k.sms_opt_out_at, c.name AS client_name,
      (SELECT count(*)::int FROM contact_properties cp WHERE cp.contact_id = k.id) AS specific
    FROM contacts k LEFT JOIN clients c ON c.id = k.client_id
    WHERE k.organization_id = ${user.organizationId} ORDER BY c.name NULLS FIRST, k.name`;

  return (
    <div className="page">
      <h1>Contacts</h1>
      <Flash search={searchParams} />
      <div className="card">
        <h2>Add a contact</h2>
        <form action={createContact} className="grid">
          <label>
            Name
            <input type="text" name="name" required />
          </label>
          <label>
            Email
            <input type="email" name="email" />
          </label>
          <label>
            Mobile
            <input type="tel" name="mobile" />
          </label>
          <label>
            Client
            <select name="client_id" defaultValue="">
              <option value="">None (internal staff)</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" name="sms_opt_in" /> Has agreed to receive text messages
          </label>
          <button type="submit">Add contact</button>
        </form>
        <p className="small muted">
          A contact linked to a client is notified about all of that client&apos;s properties, unless you limit them to
          specific properties. Contacts with no client are only notified by rules that name them. Text messages arrive
          in a later phase; the agreement is recorded now with its date.
        </p>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Client</th>
              <th>Email</th>
              <th>Mobile</th>
              <th>Texts</th>
              <th>Covers</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {contacts.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td>{k.client_name ?? <span className="muted">Internal</span>}</td>
                <td>{k.email}</td>
                <td>{k.mobile}</td>
                <td>{k.sms_opt_out_at ? 'Opted out' : k.sms_opt_in ? 'Opted in' : 'No'}</td>
                <td>
                  {k.client_name ? (
                    <Link href={`/contacts/${k.id}`}>
                      {k.specific > 0 ? `${k.specific} specific propert${k.specific === 1 ? 'y' : 'ies'}` : 'All client properties'}
                    </Link>
                  ) : (
                    <span className="muted">By rule</span>
                  )}
                </td>
                <td>
                  <form action={deleteContact}>
                    <input type="hidden" name="id" value={k.id} />
                    <button type="submit" className="link">
                      Delete
                    </button>
                  </form>
                </td>
              </tr>
            ))}
            {contacts.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No contacts yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
