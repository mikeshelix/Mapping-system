import Link from 'next/link';
import { HAZARD_LABELS, RULE_TEMPLATES, SEVERITY_LABELS, type HazardType, type Severity } from '@hazard/core';
import { getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { Flash, SeverityPill, type Search } from '@/components/Flash';
import { deleteRule, toggleRule } from '@/app/actions/rules';

function coverage(r: Record<string, unknown>): string {
  switch (r.scope) {
    case 'clients':
      return (r.client_names as string) || 'No clients';
    case 'zips':
      return `ZIP ${(r.zip_codes as string[]).join(', ')}`;
    case 'properties':
      return `${r.property_count} chosen propert${r.property_count === 1 ? 'y' : 'ies'}`;
    default:
      return 'All properties';
  }
}

export default async function RulesPage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser();
  const rules = await getSql()`
    SELECT r.id, r.name, r.enabled, r.hazard_types, r.min_severity, r.scope, r.recipient_mode, r.channels,
      (SELECT string_agg(c.name, ', ' ORDER BY c.name) FROM alert_rule_clients rc JOIN clients c ON c.id = rc.client_id WHERE rc.rule_id = r.id) AS client_names,
      (SELECT string_agg(k.name, ', ' ORDER BY k.name) FROM alert_rule_contacts rk JOIN contacts k ON k.id = rk.contact_id WHERE rk.rule_id = r.id) AS contact_names,
      COALESCE((SELECT array_agg(zip ORDER BY zip) FROM alert_rule_zips WHERE rule_id = r.id), '{}') AS zip_codes,
      (SELECT count(*)::int FROM alert_rule_properties WHERE rule_id = r.id) AS property_count
    FROM alert_rules r WHERE r.organization_id = ${user.organizationId} ORDER BY r.created_at`;

  return (
    <div className="page">
      <h1>Alert rules</h1>
      <Flash search={searchParams} />
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Rule</th>
              <th>Hazards</th>
              <th>Minimum severity</th>
              <th>Covers</th>
              <th>Notifies</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/rules/${r.id}`}>{r.name}</Link>
                </td>
                <td>
                  {r.hazard_types.length === 0
                    ? 'All hazards'
                    : (r.hazard_types as HazardType[]).map((t) => HAZARD_LABELS[t] ?? t).join(', ')}
                </td>
                <td>
                  <SeverityPill severity={r.min_severity as Severity} /> and above
                </td>
                <td>{coverage(r)}</td>
                <td>
                  {r.recipient_mode === 'linked' ? 'Contacts linked to the affected client or property' : r.contact_names || 'No contacts'}
                  <div className="small muted">by {(r.channels as string[]).map((c) => (c === 'sms' ? 'text' : c)).join(' and ')}</div>
                </td>
                <td>
                  <form action={toggleRule}>
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit" className="secondary">
                      {r.enabled ? 'On' : 'Off'}
                    </button>
                  </form>
                </td>
                <td>
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <Link href={`/rules/${r.id}`}>Edit</Link>
                    <form action={deleteRule}>
                      <input type="hidden" name="id" value={r.id} />
                      <button type="submit" className="link">
                        Delete
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
            {rules.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No rules yet. Without a rule, hazards are shown on the map but nobody is notified.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Start a new rule</h2>
          <Link className="button secondary" href="/rules/new">
            Start from blank
          </Link>
        </div>
        <p className="muted">
          Pick a template to start from. You can change every setting, and preview the rule against the last 90 days
          before saving.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
          {RULE_TEMPLATES.map((t) => (
            <Link key={t.id} href={`/rules/new?template=${t.id}`} className="template">
              <strong>{t.name}</strong>
              <span className="small muted">{t.description}</span>
              <span className="small">
                {t.hazardTypes.length ? t.hazardTypes.map((h) => HAZARD_LABELS[h]).join(', ') : 'All hazards'} ·{' '}
                {SEVERITY_LABELS[t.minSeverity]} and above
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
