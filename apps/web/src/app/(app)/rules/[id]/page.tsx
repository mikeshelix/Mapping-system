import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Severity } from '@hazard/core';
import { getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { isUuid } from '@/lib/form';
import { loadBuilderOptions } from '@/lib/ruleBuilder';
import { Flash, type Search } from '@/components/Flash';
import { RuleBuilder } from '@/components/RuleBuilder';

export default async function EditRulePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  const user = await requireUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const [rule] = await getSql()`
    SELECT r.id, r.name, r.template, r.hazard_types, r.min_severity, r.scope, r.recipient_mode, r.channels,
      COALESCE((SELECT array_agg(client_id::text) FROM alert_rule_clients WHERE rule_id = r.id), '{}') AS client_ids,
      COALESCE((SELECT array_agg(property_id::text) FROM alert_rule_properties WHERE rule_id = r.id), '{}') AS property_ids,
      COALESCE((SELECT array_agg(contact_id::text) FROM alert_rule_contacts WHERE rule_id = r.id), '{}') AS contact_ids,
      COALESCE((SELECT array_agg(zip ORDER BY zip) FROM alert_rule_zips WHERE rule_id = r.id), '{}') AS zip_codes
    FROM alert_rules r WHERE r.id = ${id} AND r.organization_id = ${user.organizationId}`;
  if (!rule) notFound();
  const options = await loadBuilderOptions(user.organizationId);

  return (
    <div className="page">
      <h1>
        Edit rule: {rule.name} <Link className="small" href="/rules">Back to rules</Link>
      </h1>
      <Flash search={searchParams} />
      <RuleBuilder
        {...options}
        initial={{
          id: rule.id,
          name: rule.name,
          template: rule.template,
          hazardTypes: rule.hazard_types,
          minSeverity: rule.min_severity as Severity,
          scope: rule.scope,
          clientIds: rule.client_ids,
          propertyIds: rule.property_ids,
          zipCodes: rule.zip_codes,
          recipientMode: rule.recipient_mode,
          contactIds: rule.contact_ids,
          sms: (rule.channels as string[]).includes('sms'),
        }}
      />
    </div>
  );
}
