// Creates a development organization, admin user, sample client and a default rule.
// Safe to run more than once.
import './env';
import { createClient } from './client';
import { hashPassword } from './password';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const orgName = process.env.SEED_ORG_NAME ?? 'Demo Restoration Co';
const email = process.env.SEED_ADMIN_EMAIL;
const password = process.env.SEED_ADMIN_PASSWORD;
if (!email || !password) throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in .env');

const sql = createClient(url, { max: 1 });
const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const [org] = await sql`
  INSERT INTO organizations (name, slug) VALUES (${orgName}, ${slug})
  ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
const orgId = org!.id as string;

await sql`
  INSERT INTO users (organization_id, email, name, password_hash, role, is_platform_admin)
  VALUES (${orgId}, ${email}, 'Admin', ${hashPassword(password)}, 'admin', true)
  ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash`;

const [{ count }] = (await sql`SELECT count(*)::int AS count FROM alert_rules WHERE organization_id = ${orgId}`) as [
  { count: number },
];
if (count === 0) {
  await sql`
    INSERT INTO alert_rules (organization_id, name, min_severity, scope, recipient_mode)
    VALUES (${orgId}, 'All hazards, severe and above', 'severe', 'all', 'linked')`;
}

console.log(`Seeded organization "${orgName}" with admin ${email} (password is SEED_ADMIN_PASSWORD in .env).`);
await sql.end();
