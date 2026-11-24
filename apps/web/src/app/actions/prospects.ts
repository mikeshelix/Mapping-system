'use server';

import { revalidatePath } from 'next/cache';
import { PROSPECT_NOTES_MAX, cleanProspectInput, isProspectStatus } from '@hazard/core';
import { addProspects, getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { back, isUuid, str } from '@/lib/form';

const PAGE = '/clients?tab=prospects';

/** Back to the prospects tab, keeping the status filter the person was looking at. */
function page(form: FormData): string {
  const filter = str(form, 'filter');
  return isProspectStatus(filter) ? `${PAGE}&status=${filter}` : PAGE;
}

export async function createProspect(form: FormData): Promise<void> {
  const user = await requireUser();
  const input = cleanProspectInput({
    name: str(form, 'name'),
    kind: str(form, 'kind'),
    address: str(form, 'address'),
    city: str(form, 'city'),
    state: str(form, 'state'),
    zip: str(form, 'zip'),
    phone: str(form, 'phone'),
    website: /^https?:\/\//i.test(str(form, 'website')) || !str(form, 'website') ? str(form, 'website') : `https://${str(form, 'website')}`,
  });
  if (!input) back(PAGE, 'error', 'Enter a name for the prospect.');
  await addProspects(getSql(), user.organizationId, user.id, [input], 'manual', '');
  revalidatePath('/clients');
  back(PAGE, 'notice', `Added ${input.name} to your prospects.`);
}

/** Saves the status, follow-up date and notes of one prospect. */
export async function updateProspect(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = str(form, 'id');
  const status = str(form, 'status');
  const followUp = str(form, 'follow_up_on');
  if (!isUuid(id) || !isProspectStatus(status)) return;
  if (followUp && !/^\d{4}-\d{2}-\d{2}$/.test(followUp)) back(page(form), 'error', 'The follow-up date is not valid.');
  await getSql()`
    UPDATE prospects SET status = ${status}, follow_up_on = ${followUp || null}::date, notes = ${str(form, 'notes').slice(0, PROSPECT_NOTES_MAX)}, updated_at = now()
    WHERE id = ${id} AND organization_id = ${user.organizationId}`;
  revalidatePath('/clients');
  back(page(form), 'notice', 'Prospect saved.');
}

/** Records that the prospect was called just now. A prospect that was still New becomes Called. */
export async function logProspectCall(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = str(form, 'id');
  if (!isUuid(id)) return;
  await getSql()`
    UPDATE prospects SET calls = calls + 1, last_contacted_at = now(), status = CASE WHEN status = 'new' THEN 'called' ELSE status END, updated_at = now()
    WHERE id = ${id} AND organization_id = ${user.organizationId}`;
  revalidatePath('/clients');
  back(page(form), 'notice', 'Call logged.');
}

export async function deleteProspect(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = str(form, 'id');
  if (!isUuid(id)) return;
  await getSql()`DELETE FROM prospects WHERE id = ${id} AND organization_id = ${user.organizationId}`;
  revalidatePath('/clients');
  back(page(form), 'notice', 'Prospect removed.');
}
