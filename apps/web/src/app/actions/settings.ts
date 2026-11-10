'use server';

import { revalidatePath } from 'next/cache';
import { flagActiveEvents, getSql } from '@hazard/db';
import { requireAdmin } from '@/lib/auth';
import { back, str } from '@/lib/form';

/** Per-event and per-day text message caps for this organization. */
export async function saveSmsCaps(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const perEvent = Number(str(form, 'per_event'));
  const perDay = Number(str(form, 'per_day'));
  const valid = (n: number) => Number.isInteger(n) && n >= 0 && n <= 100_000;
  if (!valid(perEvent) || !valid(perDay)) back('/settings', 'error', 'Caps must be whole numbers from 0 to 100,000.');
  await getSql()`
    UPDATE organizations
    SET settings = settings || ${JSON.stringify({ smsPerEventCap: perEvent, smsPerDayCap: perDay })}::text::jsonb
    WHERE id = ${admin.organizationId}`;
  revalidatePath('/settings');
  back('/settings', 'notice', 'Text message caps saved.');
}

/** Feed switches and matching distances apply to every organization, so only platform admins may change them. */
export async function saveFeedSetting(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  if (!admin.isPlatformAdmin) back('/settings', 'error', 'Only platform administrators can change feed settings.');
  const feed = str(form, 'feed');
  const enabled = form.get('enabled') === 'on';
  const bufferInput = str(form, 'buffer_miles');
  const sql = getSql();
  const [current] = await sql`SELECT buffer_meters FROM feed_settings WHERE feed = ${feed}`;
  if (!current) back('/settings', 'error', 'Unknown feed.');
  let bufferMeters: number | null = current.buffer_meters;
  if (current.buffer_meters !== null) {
    const miles = Number(bufferInput);
    if (!Number.isFinite(miles) || miles < 0 || miles > 100) back('/settings', 'error', 'Distance must be between 0 and 100 miles.');
    bufferMeters = Math.round(miles * 1609.344);
  }
  await sql`UPDATE feed_settings SET enabled = ${enabled}, buffer_meters = ${bufferMeters} WHERE feed = ${feed}`;
  if (bufferMeters !== current.buffer_meters) {
    // Clearing the fingerprint makes the next poll re-store each event with the new distance.
    await sql`UPDATE hazard_events SET content_hash = NULL WHERE source = ${feed} AND status = 'active'`;
    await flagActiveEvents(sql);
  }
  revalidatePath('/settings');
  back('/settings', 'notice', `Saved settings for ${feed.toUpperCase()}.`);
}
