import Link from 'next/link';
import { RULE_TEMPLATES } from '@hazard/core';
import { requireUser } from '@/lib/auth';
import { loadBuilderOptions } from '@/lib/ruleBuilder';
import { Flash, type Search } from '@/components/Flash';
import { RuleBuilder } from '@/components/RuleBuilder';

export default async function NewRulePage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser();
  const { template: templateId } = await searchParams;
  const template = RULE_TEMPLATES.find((t) => t.id === templateId) ?? null;
  const options = await loadBuilderOptions(user.organizationId);

  return (
    <div className="page">
      <h1>
        New rule{template ? `: ${template.name}` : ''} <Link className="small" href="/rules">Back to rules</Link>
      </h1>
      <Flash search={searchParams} />
      {template && <p className="muted">{template.description} Everything below can be changed.</p>}
      <RuleBuilder
        key={template?.id ?? 'blank'}
        {...options}
        initial={{
          id: null,
          name: template?.name ?? '',
          template: template?.id ?? null,
          hazardTypes: template?.hazardTypes ?? [],
          minSeverity: template?.minSeverity ?? 'severe',
          scope: 'all',
          clientIds: [],
          propertyIds: [],
          zipCodes: [],
          recipientMode: 'linked',
          contactIds: [],
          sms: false,
        }}
      />
    </div>
  );
}
