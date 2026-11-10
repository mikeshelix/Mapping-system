import { HAZARD_LABELS, HAZARD_TYPES, NOTIFIABLE_SEVERITIES, SEVERITY_LABELS, type HazardType, type Severity } from '@hazard/core';
import { getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { Flash, SeverityPill, type Search } from '@/components/Flash';
import { createRule, deleteRule, toggleRule } from '@/app/actions/rules';

export default async function RulesPage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser();
  const sql = getSql();
  const [rules, clients, contacts] = await Promise.all([
    sql`
      SELECT r.id, r.name, r.enabled, r.hazard_types, r.min_severity, r.scope, r.recipient_mode, r.channels,
        (SELECT string_agg(c.name, ', ' ORDER BY c.name) FROM alert_rule_clients rc JOIN clients c ON c.id = rc.client_id WHERE rc.rule_id = r.id) AS client_names,
        (SELECT string_agg(k.name, ', ' ORDER BY k.name) FROM alert_rule_contacts rk JOIN contacts k ON k.id = rk.contact_id WHERE rk.rule_id = r.id) AS contact_names
      FROM alert_rules r WHERE r.organization_id = ${user.organizationId} ORDER BY r.created_at`,
    sql`SELECT id, name FROM clients WHERE organization_id = ${user.organizationId} ORDER BY name`,
    sql`SELECT k.id, k.name, k.email, c.name AS client_name FROM contacts k LEFT JOIN clients c ON c.id = k.client_id
        WHERE k.organization_id = ${user.organizationId} ORDER BY k.name`,
  ]);

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
                <td>{r.name}</td>
                <td>
                  {r.hazard_types.length === 0
                    ? 'All hazards'
                    : (r.hazard_types as HazardType[]).map((t) => HAZARD_LABELS[t] ?? t).join(', ')}
                </td>
                <td>
                  <SeverityPill severity={r.min_severity as Severity} /> and above
                </td>
                <td>{r.scope === 'all' ? 'All properties' : r.client_names || 'No clients'}</td>
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
                  <form action={deleteRule}>
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit" className="link">
                      Delete
                    </button>
                  </form>
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
        <h2>New rule</h2>
        <form action={createRule} style={{ display: 'grid', gap: 14 }}>
          <div className="row">
            <label style={{ flex: 1, minWidth: 220 }}>
              Rule name
              <input type="text" name="name" required placeholder="Severe weather, all clients" />
            </label>
            <label>
              Minimum severity
              <select name="min_severity" defaultValue="severe">
                {NOTIFIABLE_SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {SEVERITY_LABELS[s]} and above
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset>
            <legend>Hazard types (leave all unticked for every hazard)</legend>
            <div className="checks">
              {HAZARD_TYPES.map((t) => (
                <label className="check" key={t}>
                  <input type="checkbox" name="hazard_type" value={t} /> {HAZARD_LABELS[t]}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>Which properties</legend>
            <label className="check">
              <input type="radio" name="scope" value="all" defaultChecked /> All properties
            </label>
            <label className="check">
              <input type="radio" name="scope" value="clients" /> Only these clients:
            </label>
            <div className="checks" style={{ marginLeft: 22 }}>
              {clients.map((c) => (
                <label className="check" key={c.id}>
                  <input type="checkbox" name="client_id" value={c.id} /> {c.name}
                </label>
              ))}
              {clients.length === 0 && <span className="muted">No clients yet.</span>}
            </div>
          </fieldset>
          <fieldset>
            <legend>Who is notified</legend>
            <label className="check">
              <input type="radio" name="recipient_mode" value="linked" defaultChecked /> Contacts linked to the affected
              client or property
            </label>
            <label className="check">
              <input type="radio" name="recipient_mode" value="specific" /> Only these contacts, for every affected
              property the rule covers:
            </label>
            <div className="checks" style={{ marginLeft: 22 }}>
              {contacts.map((k) => (
                <label className="check" key={k.id}>
                  <input type="checkbox" name="contact_id" value={k.id} /> {k.name}{' '}
                  <span className="muted">({k.client_name ?? 'internal'})</span>
                </label>
              ))}
              {contacts.length === 0 && <span className="muted">No contacts yet.</span>}
            </div>
          </fieldset>
          <fieldset>
            <legend>How</legend>
            <label className="check">
              <input type="checkbox" checked disabled readOnly /> Email (always)
            </label>
            <label className="check">
              <input type="checkbox" name="channel_sms" /> Also send a text message to contacts who have agreed to
              receive texts
            </label>
            <span className="small muted">
              Texts are limited by the send caps in Settings, and are only sent once a text provider is connected.
            </span>
          </fieldset>
          <p className="small muted" style={{ margin: 0 }}>
            Each contact gets one email per hazard listing all of their affected properties, and a follow-up only if the
            severity rises. Hazards of unknown severity never notify.
          </p>
          <div>
            <button type="submit">Create rule</button>
          </div>
        </form>
      </div>
    </div>
  );
}
