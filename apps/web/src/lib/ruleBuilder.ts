import { getSql } from '@hazard/db';

/** The lists the rule builder offers: clients, contacts, properties and portfolio ZIP codes. */
export async function loadBuilderOptions(organizationId: string) {
  const sql = getSql();
  const [clients, contacts, properties, zips] = await Promise.all([
    sql`SELECT id, name FROM clients WHERE organization_id = ${organizationId} ORDER BY name`,
    sql`SELECT k.id, k.name, c.name AS client_name FROM contacts k LEFT JOIN clients c ON c.id = k.client_id
        WHERE k.organization_id = ${organizationId} ORDER BY k.name`,
    sql`SELECT p.id, p.name, p.zip, c.name AS client_name FROM properties p JOIN clients c ON c.id = p.client_id
        WHERE p.organization_id = ${organizationId} ORDER BY c.name, p.name`,
    sql`SELECT left(zip, 5) AS zip, count(*)::int AS count FROM properties
        WHERE organization_id = ${organizationId} AND zip ~ '^[0-9]{5}' GROUP BY 1 ORDER BY count(*) DESC, 1`,
  ]);
  return {
    clients: clients.map((c) => ({ id: c.id as string, name: c.name as string })),
    contacts: contacts.map((k) => ({ id: k.id as string, name: k.name as string, clientName: k.client_name as string | null })),
    properties: properties.map((p) => ({ id: p.id as string, name: p.name as string, clientName: p.client_name as string, zip: p.zip as string | null })),
    zips: zips.map((z) => ({ zip: z.zip as string, count: z.count as number })),
  };
}
