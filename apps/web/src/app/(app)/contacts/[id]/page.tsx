import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { isUuid } from '@/lib/form';
import { setContactProperties } from '@/app/actions/portfolio';

export default async function ContactCoveragePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const sql = getSql();
  const [contact] = await sql`
    SELECT k.id, k.name, k.client_id, c.name AS client_name FROM contacts k LEFT JOIN clients c ON c.id = k.client_id
    WHERE k.id = ${id} AND k.organization_id = ${user.organizationId}`;
  if (!contact || !contact.client_id) notFound();
  const properties = await sql`
    SELECT p.id, p.name, p.address, p.city, p.state,
      EXISTS (SELECT 1 FROM contact_properties cp WHERE cp.contact_id = ${id} AND cp.property_id = p.id) AS selected
    FROM properties p WHERE p.client_id = ${contact.client_id} ORDER BY p.name`;

  return (
    <div className="page">
      <h1>
        Coverage for {contact.name} <span className="muted">({contact.client_name})</span>
      </h1>
      <div className="card">
        <p>
          Tick specific properties to limit this contact to those. Leave everything unticked and they are notified
          about all of {contact.client_name}&apos;s properties.
        </p>
        <form action={setContactProperties}>
          <input type="hidden" name="contact_id" value={contact.id} />
          <div style={{ maxHeight: 420, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 10 }}>
            {properties.map((p) => (
              <label className="check" key={p.id} style={{ marginBottom: 4 }}>
                <input type="checkbox" name="property_id" value={p.id} defaultChecked={p.selected} />
                {p.name}
                <span className="muted">{[p.address, p.city, p.state].filter(Boolean).join(', ')}</span>
              </label>
            ))}
            {properties.length === 0 && <span className="muted">This client has no properties yet.</span>}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button type="submit">Save coverage</button>
            <Link href="/contacts">Cancel</Link>
          </div>
        </form>
      </div>
    </div>
  );
}
