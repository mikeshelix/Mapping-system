/**
 * Session handling.
 *
 * This is the single seam for authentication. When the app is embedded in the
 * Helixco suite, replace the body of getUser() with a lookup of the suite's own
 * session and map it to SessionUser; nothing else in the app reads cookies.
 */
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSql, hashToken, newSessionToken, verifyPassword } from '@hazard/db';

export interface SessionUser {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  name: string;
  role: 'admin' | 'staff';
  isPlatformAdmin: boolean;
}

const COOKIE = 'hz_session';
const SESSION_DAYS = 14;

export const getUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const sql = getSql();
  const [row] = await sql`
    SELECT u.id, u.organization_id, o.name AS organization_name, u.email, u.name, u.role, u.is_platform_admin
    FROM sessions s JOIN users u ON u.id = s.user_id JOIN organizations o ON o.id = u.organization_id
    WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > now()`;
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    email: row.email,
    name: row.name,
    role: row.role,
    isPlatformAdmin: row.is_platform_admin,
  };
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getUser();
  if (!user) redirect('/login');
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== 'admin') redirect('/?error=' + encodeURIComponent('Admins only'));
  return user;
}

export async function signIn(email: string, password: string): Promise<boolean> {
  const sql = getSql();
  const [user] = await sql`SELECT id, password_hash FROM users WHERE lower(email) = ${email.trim().toLowerCase()}`;
  // Verify even when the user is missing so response time does not reveal which emails exist.
  const ok = verifyPassword(password, user?.password_hash ?? 'scrypt$00$00') && !!user;
  if (!ok) return false;
  const token = newSessionToken();
  await sql`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${hashToken(token)}, ${user.id}, now() + make_interval(days => ${SESSION_DAYS}))`;
  await sql`DELETE FROM sessions WHERE expires_at < now()`;
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
  return true;
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await getSql()`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
  jar.delete(COOKIE);
}
