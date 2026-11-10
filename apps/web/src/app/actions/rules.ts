'use server';

import { revalidatePath } from 'next/cache';
import { HAZARD_TYPES, NOTIFIABLE_SEVERITIES, RULE_TEMPLATES, type Channel, type RuleInput, type Severity } from '@hazard/core';
import { flagActiveEvents, getSql, previewRule, type RulePreviewResult } from '@hazard/db';
import { requireUser, type SessionUser } from '@/lib/auth';
import { back, isUuid, list, str } from '@/lib/form';

interface RuleDraft {
  id: string | null;
  name: string;
  template: string | null;
  hazardTypes: string[];
  minSeverity: Severity;
  scope: RuleInput['scope'];
  clientIds: string[];
  propertyIds: string[];
  zipCodes: string[];
  recipientMode: RuleInput['recipientMode'];
  contactIds: string[];
  channels: Channel[];
}

/** Read and validate the rule builder form. Returns an error message instead of a draft when invalid. */
function readDraft(form: FormData, requireName: boolean): RuleDraft | string {
  const id = str(form, 'id');
  const name = str(form, 'name');
  const minSeverity = str(form, 'min_severity');
  const scopeInput = str(form, 'scope');
  const scope = (['all', 'clients', 'properties', 'zips'] as const).find((s) => s === scopeInput) ?? 'all';
  const recipientMode = str(form, 'recipient_mode') === 'specific' ? 'specific' : 'linked';
  const template = RULE_TEMPLATES.some((t) => t.id === str(form, 'template')) ? str(form, 'template') : null;
  const zipCodes = [...new Set(str(form, 'zip_codes').split(/[\s,;]+/).map((z) => z.trim().slice(0, 5)).filter(Boolean))];
  const draft: RuleDraft = {
    id: isUuid(id) ? id : null,
    name,
    template,
    hazardTypes: list(form, 'hazard_type').filter((t) => (HAZARD_TYPES as readonly string[]).includes(t)),
    minSeverity: minSeverity as Severity,
    scope,
    clientIds: scope === 'clients' ? list(form, 'client_id').filter(isUuid) : [],
    propertyIds: scope === 'properties' ? list(form, 'property_id').filter(isUuid) : [],
    zipCodes: scope === 'zips' ? zipCodes : [],
    recipientMode,
    contactIds: recipientMode === 'specific' ? list(form, 'contact_id').filter(isUuid) : [],
    // Email is the default channel; SMS only when the rule explicitly asks for it.
    channels: form.get('channel_sms') === 'on' ? ['email', 'sms'] : ['email'],
  };
  if (requireName && !name) return 'Give the rule a name.';
  if (!(NOTIFIABLE_SEVERITIES as readonly string[]).includes(minSeverity)) return 'Choose a minimum severity.';
  if (scope === 'clients' && draft.clientIds.length === 0) return 'Choose at least one client, or cover all properties.';
  if (scope === 'properties' && draft.propertyIds.length === 0) return 'Choose at least one property, or cover all properties.';
  if (scope === 'zips' && draft.zipCodes.length === 0) return 'Enter at least one ZIP code, or cover all properties.';
  if (scope === 'zips' && draft.zipCodes.some((z) => !/^\d{5}$/.test(z))) return 'ZIP codes must be five digits, separated by commas or spaces.';
  if (recipientMode === 'specific' && draft.contactIds.length === 0) return 'Choose at least one contact to notify.';
  return draft;
}

function toRuleInput(draft: RuleDraft, user: SessionUser): RuleInput {
  return { ...draft, id: draft.id ?? 'draft', organizationId: user.organizationId, enabled: true };
}

export interface PreviewState {
  error?: string;
  preview?: RulePreviewResult;
}

/** "Preview" button: replay the last 90 days through the rule as currently filled in. Saves nothing. */
export async function previewRuleAction(_previous: PreviewState, form: FormData): Promise<PreviewState> {
  const user = await requireUser();
  const draft = readDraft(form, false);
  if (typeof draft === 'string') return { error: draft };
  const sql = getSql();
  // Drop any IDs that are not this organization's before replaying.
  const [owned] = await sql`
    SELECT
      COALESCE((SELECT array_agg(id::text) FROM clients WHERE id = ANY(${draft.clientIds}::uuid[]) AND organization_id = ${user.organizationId}), '{}') AS client_ids,
      COALESCE((SELECT array_agg(id::text) FROM properties WHERE id = ANY(${draft.propertyIds}::uuid[]) AND organization_id = ${user.organizationId}), '{}') AS property_ids,
      COALESCE((SELECT array_agg(id::text) FROM contacts WHERE id = ANY(${draft.contactIds}::uuid[]) AND organization_id = ${user.organizationId}), '{}') AS contact_ids`;
  const rule = toRuleInput({ ...draft, clientIds: owned!.client_ids, propertyIds: owned!.property_ids, contactIds: owned!.contact_ids }, user);
  try {
    return { preview: await previewRule(sql, rule) };
  } catch {
    return { error: 'The preview could not be calculated. Try again.' };
  }
}

/** Create a rule, or update it when the form carries an id. */
export async function saveRule(form: FormData): Promise<void> {
  const user = await requireUser();
  const formId = str(form, 'id');
  const returnTo = isUuid(formId) ? `/rules/${formId}` : '/rules/new';
  const draft = readDraft(form, true);
  if (typeof draft === 'string') back(returnTo, 'error', draft);
  const org = user.organizationId;
  const sql = getSql();

  await sql.begin(async (tx) => {
    let ruleId = draft.id;
    if (ruleId) {
      const updated = await tx`
        UPDATE alert_rules SET name = ${draft.name}, hazard_types = ${draft.hazardTypes}::text[],
          min_severity = ${draft.minSeverity}::severity, scope = ${draft.scope}, recipient_mode = ${draft.recipientMode},
          channels = ${draft.channels}::text[]
        WHERE id = ${ruleId} AND organization_id = ${org} RETURNING id`;
      if (updated.length === 0) throw new Error('Rule not found');
      await tx`DELETE FROM alert_rule_clients WHERE rule_id = ${ruleId}`;
      await tx`DELETE FROM alert_rule_properties WHERE rule_id = ${ruleId}`;
      await tx`DELETE FROM alert_rule_zips WHERE rule_id = ${ruleId}`;
      await tx`DELETE FROM alert_rule_contacts WHERE rule_id = ${ruleId}`;
    } else {
      const [row] = await tx`
        INSERT INTO alert_rules (organization_id, name, hazard_types, min_severity, scope, recipient_mode, channels, template)
        VALUES (${org}, ${draft.name}, ${draft.hazardTypes}::text[], ${draft.minSeverity}::severity, ${draft.scope},
          ${draft.recipientMode}, ${draft.channels}::text[], ${draft.template})
        RETURNING id`;
      ruleId = row!.id as string;
    }
    // Selecting through the organization's own rows keeps another tenant's IDs out.
    if (draft.clientIds.length) {
      await tx`INSERT INTO alert_rule_clients (rule_id, client_id)
        SELECT ${ruleId}, id FROM clients WHERE id = ANY(${draft.clientIds}::uuid[]) AND organization_id = ${org}`;
    }
    if (draft.propertyIds.length) {
      await tx`INSERT INTO alert_rule_properties (rule_id, property_id)
        SELECT ${ruleId}, id FROM properties WHERE id = ANY(${draft.propertyIds}::uuid[]) AND organization_id = ${org}`;
    }
    if (draft.zipCodes.length) {
      await tx`INSERT INTO alert_rule_zips (rule_id, zip) SELECT ${ruleId}, z FROM unnest(${draft.zipCodes}::text[]) AS z`;
    }
    if (draft.contactIds.length) {
      await tx`INSERT INTO alert_rule_contacts (rule_id, contact_id)
        SELECT ${ruleId}, id FROM contacts WHERE id = ANY(${draft.contactIds}::uuid[]) AND organization_id = ${org}`;
    }
  });
  await flagActiveEvents(sql, org);
  revalidatePath('/rules');
  back('/rules', 'notice', `Rule "${draft.name}" ${draft.id ? 'updated' : 'created'}. It also applies to hazards already in effect.`);
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
