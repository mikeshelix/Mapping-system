'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSql, hashPassword } from '@hazard/db';
import { requireAdmin, signIn, signOut } from '@/lib/auth';
import { back, isUuid, str } from '@/lib/form';

export async function login(form: FormData): Promise<void> {
  const ok = await signIn(str(form, 'email'), String(form.get('password') ?? ''));
  if (!ok) back('/login', 'error', 'Email or password is incorrect.');
  redirect('/');
}

export async function logout(): Promise<void> {
  await signOut();
  redirect('/login');
}

export async function createUser(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const email = str(form, 'email').toLowerCase();
  const name = str(form, 'name');
  const password = String(form.get('password') ?? '');
  const role = str(form, 'role') === 'admin' ? 'admin' : 'staff';
  if (!email || !name) back('/users', 'error', 'Name and email are required.');
  if (password.length < 10) back('/users', 'error', 'Password must be at least 10 characters.');
  const sql = getSql();
  const [existing] = await sql`SELECT 1 FROM users WHERE lower(email) = ${email}`;
  if (existing) back('/users', 'error', 'A user with that email already exists.');
  await sql`
    INSERT INTO users (organization_id, email, name, password_hash, role)
    VALUES (${admin.organizationId}, ${email}, ${name}, ${hashPassword(password)}, ${role})`;
  revalidatePath('/users');
  back('/users', 'notice', `Added ${name}.`);
}

export async function deleteUser(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = str(form, 'id');
  if (!isUuid(id) || id === admin.id) back('/users', 'error', 'You cannot remove your own account.');
  await getSql()`DELETE FROM users WHERE id = ${id} AND organization_id = ${admin.organizationId}`;
  revalidatePath('/users');
}
