'use client';

import { startTransition, useActionState, useMemo, useRef, useState } from 'react';
import {
  HAZARD_LABELS,
  HAZARD_TYPES,
  NOTIFIABLE_SEVERITIES,
  SEVERITY_COLORS,
  SEVERITY_LABELS,
  type HazardType,
  type Severity,
} from '@hazard/core';
import { previewRuleAction, saveRule, type PreviewState } from '@/app/actions/rules';

export interface RuleFormValues {
  id: string | null;
  name: string;
  template: string | null;
  hazardTypes: string[];
  minSeverity: Severity;
  scope: 'all' | 'clients' | 'properties' | 'zips';
  clientIds: string[];
  propertyIds: string[];
  zipCodes: string[];
  recipientMode: 'linked' | 'specific';
  contactIds: string[];
  sms: boolean;
}

interface Props {
  initial: RuleFormValues;
  clients: Array<{ id: string; name: string }>;
  contacts: Array<{ id: string; name: string; clientName: string | null }>;
  properties: Array<{ id: string; name: string; clientName: string; zip: string | null }>;
  /** ZIP codes present in the portfolio, with how many properties are in each. */
  zips: Array<{ zip: string; count: number }>;
}

const SEVERITY_HELP: Record<string, string> = {
  minor: 'Advisories and anything stronger. Expect many messages.',
  moderate: 'Watches, moderate events and anything stronger.',
  severe: 'Warnings and damaging events. A common starting point.',
  extreme: 'Only the most dangerous events.',
};

export function RuleBuilder({ initial, clients, contacts, properties, zips }: Props) {
  const [state, previewAction, previewing] = useActionState<PreviewState, FormData>(previewRuleAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  // Run the preview by hand rather than as a form action: a form action resets the
  // form afterwards, which would throw away the edits being previewed.
  const runPreview = () => {
    if (!formRef.current) return;
    const data = new FormData(formRef.current);
    startTransition(() => previewAction(data));
  };
  const [scope, setScope] = useState(initial.scope);
  const [recipientMode, setRecipientMode] = useState(initial.recipientMode);
  const [zipText, setZipText] = useState(initial.zipCodes.join(', '));
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set(initial.propertyIds));

  const shownProperties = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? properties.filter((p) => `${p.name} ${p.clientName} ${p.zip ?? ''}`.toLowerCase().includes(q)) : properties;
    return list.slice(0, 300);
  }, [filter, properties]);

  const addZip = (zip: string) =>
    setZipText((text) => {
      const have = text.split(/[\s,;]+/).filter(Boolean);
      return have.includes(zip) ? text : [...have, zip].join(', ');
    });

  const preview = state.preview;

  return (
    <form ref={formRef} action={saveRule} style={{ display: 'grid', gap: 14 }}>
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      {initial.template && <input type="hidden" name="template" value={initial.template} />}

      <div className="card" style={{ display: 'grid', gap: 14, marginBottom: 0 }}>
        <h2>1. What to watch for</h2>
        <label style={{ maxWidth: 420 }}>
          Rule name
          <input type="text" name="name" defaultValue={initial.name} placeholder="Severe weather, all clients" />
        </label>
        <fieldset>
          <legend>Hazard types (leave all unticked for every hazard)</legend>
          <div className="checks">
            {HAZARD_TYPES.map((t) => (
              <label className="check" key={t}>
                <input type="checkbox" name="hazard_type" value={t} defaultChecked={initial.hazardTypes.includes(t)} />{' '}
                {HAZARD_LABELS[t as HazardType]}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Notify when severity reaches</legend>
          {NOTIFIABLE_SEVERITIES.map((s) => (
            <label className="check" key={s} style={{ marginBottom: 2 }}>
              <input type="radio" name="min_severity" value={s} defaultChecked={initial.minSeverity === s} />
              <span className="pill" style={{ background: SEVERITY_COLORS[s] }}>
                {SEVERITY_LABELS[s]}
              </span>
              <span className="muted small">{SEVERITY_HELP[s]}</span>
            </label>
          ))}
        </fieldset>
      </div>

      <div className="card" style={{ display: 'grid', gap: 10, marginBottom: 0 }}>
        <h2>2. Which properties</h2>
        {(
          [
            ['all', 'All properties'],
            ['clients', 'Chosen clients'],
            ['zips', 'Chosen ZIP codes'],
            ['properties', 'Chosen properties'],
          ] as const
        ).map(([value, label]) => (
          <label className="check" key={value}>
            <input type="radio" name="scope" value={value} checked={scope === value} onChange={() => setScope(value)} /> {label}
          </label>
        ))}

        {scope === 'clients' && (
          <div className="checks" style={{ marginLeft: 22 }}>
            {clients.map((c) => (
              <label className="check" key={c.id}>
                <input type="checkbox" name="client_id" value={c.id} defaultChecked={initial.clientIds.includes(c.id)} /> {c.name}
              </label>
            ))}
            {clients.length === 0 && <span className="muted">No clients yet.</span>}
          </div>
        )}

        {scope === 'zips' && (
          <div style={{ marginLeft: 22, display: 'grid', gap: 6 }}>
            <label>
              ZIP codes, separated by commas or spaces
              <input type="text" name="zip_codes" value={zipText} onChange={(e) => setZipText(e.target.value)} placeholder="98584, 20500" />
            </label>
            {zips.length > 0 && (
              <div className="small">
                <span className="muted">ZIP codes in your portfolio (click to add): </span>
                {zips.slice(0, 60).map((z) => (
                  <button key={z.zip} type="button" className="secondary" style={{ padding: '1px 8px', margin: '0 4px 4px 0' }} onClick={() => addZip(z.zip)}>
                    {z.zip} <span className="muted">({z.count})</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {scope === 'properties' && (
          <div style={{ marginLeft: 22, display: 'grid', gap: 6 }}>
            <input type="text" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name, client or ZIP" aria-label="Filter properties" style={{ maxWidth: 320 }} />
            {/* Every picked property is submitted, including ones hidden by the filter. */}
            {[...picked].map((id) => (
              <input key={id} type="hidden" name="property_id" value={id} />
            ))}
            <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
              {shownProperties.map((p) => (
                <label className="check" key={p.id} style={{ marginBottom: 2 }}>
                  <input
                    type="checkbox"
                    checked={picked.has(p.id)}
                    onChange={() =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (next.has(p.id)) next.delete(p.id);
                        else next.add(p.id);
                        return next;
                      })
                    }
                  />
                  {p.name}{' '}
                  <span className="muted small">
                    {p.clientName}
                    {p.zip ? ` · ${p.zip}` : ''}
                  </span>
                </label>
              ))}
              {shownProperties.length === 0 && <span className="muted">No properties match.</span>}
            </div>
            <span className="small muted">
              {picked.size} chosen
              {properties.length > shownProperties.length ? `. Showing ${shownProperties.length} of ${properties.length}; filter to find more.` : ''}
            </span>
          </div>
        )}
      </div>

      <div className="card" style={{ display: 'grid', gap: 10, marginBottom: 0 }}>
        <h2>3. Who is told, and how</h2>
        <label className="check">
          <input type="radio" name="recipient_mode" value="linked" checked={recipientMode === 'linked'} onChange={() => setRecipientMode('linked')} />
          Contacts linked to the affected client or property
        </label>
        <label className="check">
          <input type="radio" name="recipient_mode" value="specific" checked={recipientMode === 'specific'} onChange={() => setRecipientMode('specific')} />
          Only chosen contacts, for every affected property the rule covers
        </label>
        {recipientMode === 'specific' && (
          <div className="checks" style={{ marginLeft: 22 }}>
            {contacts.map((k) => (
              <label className="check" key={k.id}>
                <input type="checkbox" name="contact_id" value={k.id} defaultChecked={initial.contactIds.includes(k.id)} /> {k.name}{' '}
                <span className="muted">({k.clientName ?? 'internal'})</span>
              </label>
            ))}
            {contacts.length === 0 && <span className="muted">No contacts yet.</span>}
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked disabled readOnly /> Email (always)
        </label>
        <label className="check">
          <input type="checkbox" name="channel_sms" defaultChecked={initial.sms} /> Also send a text message to contacts who have agreed to receive texts
        </label>
        <p className="small muted" style={{ margin: 0 }}>
          Each contact gets one message per hazard listing all of their affected properties, and a follow-up only if the
          severity rises. Hazards of unknown severity never notify.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 0 }}>
        <h2>4. Check it against the last 90 days</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          See what this rule would have sent, using the hazards stored over the last 90 days and your current
          properties and contacts. Nothing is saved or sent.
        </p>
        <div className="row">
          <button type="button" className="secondary" onClick={runPreview} disabled={previewing}>
            {previewing ? 'Replaying…' : 'Preview the last 90 days'}
          </button>
          <button type="submit">{initial.id ? 'Save changes' : 'Create rule'}</button>
        </div>
        {state.error && (
          <div className="flash error" style={{ marginTop: 12, marginBottom: 0 }}>
            {state.error}
          </div>
        )}
        {preview && (
          <div style={{ marginTop: 14 }}>
            <div className="stats" style={{ flexWrap: 'wrap' }}>
              <div>
                <strong>{preview.eventsMatched.toLocaleString()}</strong>hazards acted on
              </div>
              <div>
                <strong>{preview.propertiesAffected.toLocaleString()}</strong>properties affected
              </div>
              <div>
                <strong>{preview.messages.email.toLocaleString()}</strong>emails
              </div>
              <div>
                <strong>{preview.messages.sms.toLocaleString()}</strong>texts
              </div>
              <div>
                <strong>{preview.contactsNotified.toLocaleString()}</strong>contacts reached
              </div>
            </div>
            <p className="small muted">
              Out of {preview.eventsConsidered.toLocaleString()} stored hazards that touched your properties.{' '}
              {preview.followUps > 0 && `${preview.followUps.toLocaleString()} of the messages are follow-ups after a severity increase. `}
              Text counts are before send caps.
              {preview.historyStart &&
                Date.now() - Date.parse(preview.historyStart) < preview.days * 86_400_000 &&
                ` Hazard history only goes back to ${new Date(preview.historyStart).toLocaleDateString()}, so this covers less than ${preview.days} days.`}
            </p>
            {preview.eventsMatched === 0 && (
              <p>This rule would not have sent anything. Check that the covered properties have contacts, or lower the severity.</p>
            )}
            {preview.byHazard.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Hazard type</th>
                    <th>Hazards</th>
                    <th>Messages</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.byHazard.map((h) => (
                    <tr key={h.hazardType}>
                      <td>{HAZARD_LABELS[h.hazardType as HazardType] ?? h.hazardType}</td>
                      <td>{h.events.toLocaleString()}</td>
                      <td>{h.messages.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {preview.busiest.length > 0 && (
              <>
                <h2 style={{ marginTop: 14 }}>Hazards that would have sent the most</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Hazard</th>
                      <th>First seen</th>
                      <th>Peak severity</th>
                      <th>Properties</th>
                      <th>Messages</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.busiest.map((e) => (
                      <tr key={e.id}>
                        <td>{e.eventName}</td>
                        <td>{new Date(e.firstSeenAt).toLocaleString()}</td>
                        <td>
                          <span className="pill" style={{ background: SEVERITY_COLORS[e.severity] }}>
                            {SEVERITY_LABELS[e.severity]}
                          </span>
                        </td>
                        <td>{e.properties}</td>
                        <td>{e.messages}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}
      </div>
    </form>
  );
}
