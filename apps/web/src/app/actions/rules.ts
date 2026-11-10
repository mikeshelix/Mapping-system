'use server';

import { revalidatePath } from 'next/cache';
import { HAZARD_TYPES, NOTIFIABLE_SEVERITIES } from '@hazard/core';
import { flagActiveEvents, getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { back, isUuid, list, str } from '@/lib/form';

export async function createRule(form: FormData): Promise<void> {
  const user = await requireUser();
  const name = str(form, 'name');
  const minSeverity = str(form, 'min_severity');
  const hazardTypes = list(form, 'hazard_type').filter((t) => (HAZARD_TYPES as readonly string[]).includes(t));
  const scope = str(form, 'scope') === 'clients' ? 'clients' : 'all';
  const recipientMode = str(form, 'recipient_mode') === 'specific' ? 'specific' : 'linked';
  const clientIds = list(form, 'client_id').filter(isUuid);
  const contactIds = list(form, 'contact_id').filter(isUuid);

  if (!name) back('/rules', 'error', 'Rule name is required.');
  if (!(NOTIFIABLE_SEVERITIES as readonly string[]).includes(minSeverity)) back('/rules', 'error', 'Choose a minimum severity.');
  if (scope === 'clients' && clientIds.length === 0) back('/rules', 'error', 'Choose at least one client, or cover all clients.');
  if (recipientMode === 'specific' && contactIds.length === 0) back('/rules', 'error', 'Choose at least one contact to notify.');

  const sql = getSql();
  await sql.begin(async (tx) => {
    const [rule] = await tx`
      INSERT INTO alert_rules (organization_id, name, hazard_types, min_severity, scope, recipient_mode, channels)
      VALUES (${user.organizationId}, ${name}, ${hazardTypes}::text[], ${minSeverity}::severity, ${scope}, ${recipientMode}, '{email}')
      RETURNING id`;
    const ruleId = rule!.id as string;
    // Selecting through the organization's own rows keeps another tenant's IDs out.
    if (scope === 'clients') {
      await tx`
        INSERT INTO alert_rule_clients (rule_id, client_id)
        SELECT ${ruleId}, id FROM clients WHERE id = ANY(${clientIds}::uuid[]) AND organization_id = ${user.organizationId}`;
    }
    if (recipientMode === 'specific') {
      await tx`
        INSERT INTO alert_rule_contacts (rule_id, contact_id)
        SELECT ${ruleId}, id FROM contacts WHERE id = ANY(${contactIds}::uuid[]) AND organization_id = ${user.organizationId}`;
    }
  });
  await flagActiveEvents(sql, user.organizationId);
  revalidatePath('/rules');
  back('/rules', 'notice', `Rule "${name}" created. It also applies to hazards already in effect.`);
}

export async function toggleRule(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = str(form, 'id');
  if (!isUuid(id)) return;
  const sql = getSql();
  await sql`UPDATE alert_rules SET enabled = NOT enabled WHERE id = ${id} AND organization_id = ${user.organizationId}`;
  await flagActiveEvents(sql, user.organizationId);
  revalidatePath('/rules');
}

export async function deleteRule(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = str(form, 'id');
  if (!isUuid(id)) return;
  await getSql()`DELETE FROM alert_rules WHERE id = ${id} AND organization_id = ${user.organizationId}`;
  revalidatePath('/rules');
}
