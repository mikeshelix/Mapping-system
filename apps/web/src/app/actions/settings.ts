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

/** Share of declared value assumed at risk for each severity, used for the exposure estimate. */
export async function saveExposureFactors(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const factors: Record<string, number> = {};
  for (const severity of ['minor', 'moderate', 'severe', 'extreme']) {
    const percent = Number(str(form, `factor_${severity}`));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) back('/settings', 'error', 'Each percentage must be between 0 and 100.');
    factors[severity] = Math.round(percent * 100) / 10_000;
  }
  await getSql()`
    UPDATE organizations SET settings = settings || ${JSON.stringify({ exposureFactors: factors })}::text::jsonb
    WHERE id = ${admin.organizationId}`;
  revalidatePath('/settings');
  revalidatePath('/impacts');
  back('/settings', 'notice', 'Exposure percentages saved.');
}

/** Monthly limit on assistant questions and daily limit on area searches, for this organization. */
export async function saveUsageLimits(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const questions = Number(str(form, 'assistant_monthly'));
  const searches = Number(str(form, 'area_daily'));
  const valid = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;
  if (!valid(questions, 100_000) || !valid(searches, 5_000)) {
    back('/settings', 'error', 'Limits must be whole numbers: up to 100,000 questions a month and 5,000 area searches a day.');
  }
  await getSql()`
    UPDATE organizations
    SET settings = settings || ${JSON.stringify({ assistantMonthlyCap: questions, areaSearchDailyCap: searches })}::text::jsonb
    WHERE id = ${admin.organizationId}`;
  revalidatePath('/settings');
  back('/settings', 'notice', 'Usage limits saved.');
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
