import { NextResponse } from 'next/server';
import { getSql } from '@hazard/db';
import { getUser } from '@/lib/auth';
import { isUuid } from '@/lib/form';

export const dynamic = 'force-dynamic';

/** One location's details for the card on the map: what it is, what is affecting it, and who gets told. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const sql = getSql();
  const org = user.organizationId;
  const [p] = await sql`
    SELECT p.id, p.name, concat_ws(', ', p.address, p.city, p.state, p.zip) AS address, p.property_type, p.declared_value,
      p.geocode_source, c.id AS client_id, c.name AS client, c.color
    FROM properties p JOIN clients c ON c.id = p.client_id
    WHERE p.id = ${id} AND p.organization_id = ${org}`;
  if (!p) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const [alerts, contacts] = await Promise.all([
    sql`
      SELECT e.id, e.event_name, e.hazard_type, i.severity, e.headline, e.ends_at, e.source_url
      FROM property_impacts i JOIN hazard_events e ON e.id = i.hazard_event_id AND e.status = 'active'
      WHERE i.property_id = ${id} AND i.organization_id = ${org}
      ORDER BY i.severity DESC, i.first_matched_at DESC`,
    // Contacts tied to this location directly or through its client.
    sql`
      SELECT k.id, k.name, k.email IS NOT NULL AS email, (k.sms_opt_in AND k.sms_opt_out_at IS NULL AND k.mobile IS NOT NULL) AS text
      FROM contacts k
      WHERE k.organization_id = ${org}
        AND (k.client_id = ${p.client_id} OR EXISTS (SELECT 1 FROM contact_properties cp WHERE cp.contact_id = k.id AND cp.property_id = ${id}))
      ORDER BY k.name LIMIT 50`,
  ]);
  return NextResponse.json({
    id: p.id,
    name: p.name,
    address: p.address,
    propertyType: p.property_type,
    declaredValue: p.declared_value === null ? null : Number(p.declared_value),
    placedBy: p.geocode_source === 'manual' ? 'pin' : 'address',
    client: p.client,
    clientColor: p.color,
    alerts: alerts.map((a) => ({ id: a.id, name: a.event_name, hazardType: a.hazard_type, severity: a.severity, headline: a.headline, endsAt: a.ends_at, sourceUrl: a.source_url })),
    contacts: contacts.map((k) => ({ id: k.id, name: k.name, email: k.email, text: k.text })),
  });
}
