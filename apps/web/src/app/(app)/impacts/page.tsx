import Link from 'next/link';
import { estimateExposure, EXPOSURE_NOTE, NOTIFIABLE_SEVERITIES, readExposureFactors, SEVERITY_LABELS, SOURCE_NAMES, type Severity, type SourceId } from '@hazard/core';
import { getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { isUuid } from '@/lib/form';
import { SeverityPill, when, type Search } from '@/components/Flash';

const LIMIT = 500;

/** Every affected property, worst first: the answer to "who is affected right now, and how badly?" */
export default async function ImpactsPage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser();
  const sp = await searchParams;
  const minSeverity = (NOTIFIABLE_SEVERITIES as readonly string[]).includes(sp.severity ?? '') ? (sp.severity as Severity) : null;
  const clientId = sp.client && isUuid(sp.client) ? sp.client : null;
  const sql = getSql();

  const [clients, rows, summary, worst, [org]] = await Promise.all([
    sql`SELECT id, name FROM clients WHERE organization_id = ${user.organizationId} ORDER BY name`,
    sql`
      SELECT i.id, i.severity, i.first_matched_at, e.id AS event_id, e.event_name, e.source, e.headline, e.ends_at,
        p.name AS property_name, concat_ws(', ', p.address, p.city, p.state) AS address, p.declared_value,
        c.name AS client_name, c.color, count(*) OVER()::int AS total
      FROM property_impacts i
      JOIN hazard_events e ON e.id = i.hazard_event_id AND e.status = 'active'
      JOIN properties p ON p.id = i.property_id
      JOIN clients c ON c.id = p.client_id
      WHERE i.organization_id = ${user.organizationId}
        ${minSeverity ? sql`AND i.severity >= ${minSeverity}::severity` : sql``}
        ${clientId ? sql`AND p.client_id = ${clientId}` : sql``}
      ORDER BY i.severity DESC, i.first_matched_at DESC, p.name
      LIMIT ${LIMIT}`,
    sql`
      SELECT i.severity, count(DISTINCT i.property_id)::int AS properties
      FROM property_impacts i JOIN hazard_events e ON e.id = i.hazard_event_id AND e.status = 'active'
      WHERE i.organization_id = ${user.organizationId} GROUP BY i.severity`,
    // One row per affected property with its worst current severity, for the exposure total.
    sql`
      SELECT p.id, p.declared_value, max(i.severity) AS severity
      FROM property_impacts i
      JOIN hazard_events e ON e.id = i.hazard_event_id AND e.status = 'active'
      JOIN properties p ON p.id = i.property_id
      WHERE i.organization_id = ${user.organizationId}
        ${minSeverity ? sql`AND i.severity >= ${minSeverity}::severity` : sql``}
        ${clientId ? sql`AND p.client_id = ${clientId}` : sql``}
      GROUP BY p.id`,
    sql`SELECT settings FROM organizations WHERE id = ${user.organizationId}`,
  ]);
  const factors = readExposureFactors(org?.settings);
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
  let exposureTotal = 0;
  let unvalued = 0;
  for (const p of worst) {
    const estimate = estimateExposure(p.declared_value, p.severity as Severity, factors);
    if (estimate === null) unvalued++;
    else exposureTotal += estimate;
  }
  const exportQuery = new URLSearchParams({ ...(minSeverity ? { severity: minSeverity } : {}), ...(clientId ? { client: clientId } : {}) }).toString();
  const total = rows[0]?.total ?? 0;
  const bySeverity = new Map(summary.map((s) => [s.severity as Severity, s.properties as number]));

  return (
    <div className="page" style={{ maxWidth: 1300 }}>
      <h1>Affected properties, worst first</h1>
      <div className="card stats">
        {[...NOTIFIABLE_SEVERITIES].reverse().map((s) => (
          <div key={s}>
            <strong>{(bySeverity.get(s) ?? 0).toLocaleString()}</strong>
            <SeverityPill severity={s} />
          </div>
        ))}
      </div>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="stats">
            <div>
              <strong>{money(exposureTotal)}</strong>estimated exposure
            </div>
            <div>
              <strong>{worst.length.toLocaleString()}</strong>properties affected
            </div>
          </div>
          <div className="row">
            <a className="button secondary" href={`/api/export/impacts${exportQuery ? `?${exportQuery}` : ''}`}>
              Export impacts (CSV)
            </a>
            <a className="button secondary" href={`/api/export/exposure${exportQuery ? `?${exportQuery}` : ''}`}>
              Export exposure (CSV)
            </a>
          </div>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          {EXPOSURE_NOTE} Each property is counted once, at its worst current severity.
          {unvalued > 0 && ` ${unvalued} affected propert${unvalued === 1 ? 'y has' : 'ies have'} no declared value and add nothing to the total.`}
        </p>
      </div>
      <div className="card">
        <form className="row" style={{ marginBottom: 12 }}>
          <label>
            Show
            <select name="severity" defaultValue={minSeverity ?? ''}>
              <option value="">All severities</option>
              {NOTIFIABLE_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABELS[s]} and above
                </option>
              ))}
            </select>
          </label>
          <label>
            Client
            <select name="client" defaultValue={clientId ?? ''}>
              <option value="">All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="secondary" style={{ alignSelf: 'flex-end' }}>
            Apply
          </button>
          <span className="muted" style={{ alignSelf: 'flex-end' }}>
            {total.toLocaleString()} impact{total === 1 ? '' : 's'}
            {total > LIMIT ? `, showing the worst ${LIMIT}` : ''}
          </span>
        </form>
        <table>
          <thead>
            <tr>
              <th>Severity</th>
              <th>Property</th>
              <th>Client</th>
              <th>Hazard</th>
              <th>Source</th>
              <th>Since</th>
              <th>Declared value</th>
              <th>Estimated exposure</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <SeverityPill severity={r.severity as Severity} />
                </td>
                <td>
                  {r.property_name}
                  <div className="small muted">{r.address}</div>
                </td>
                <td>
                  <span className="swatch" style={{ background: r.color }} />
                  {r.client_name}
                </td>
                <td>
                  {r.event_name}
                  {r.ends_at && <div className="small muted">until {when(r.ends_at)}</div>}
                </td>
                <td className="small">{SOURCE_NAMES[r.source as SourceId] ?? r.source}</td>
                <td>{when(r.first_matched_at)}</td>
                <td>{r.declared_value != null ? money(Number(r.declared_value)) : <span className="muted">not set</span>}</td>
                <td>
                  {(() => {
                    const estimate = estimateExposure(r.declared_value, r.severity as Severity, factors);
                    return estimate === null ? <span className="muted">n/a</span> : `${money(estimate)} est.`;
                  })()}
                </td>
                <td>
                  <Link href={`/?event=${r.event_id}`}>Map</Link>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  No properties are affected by an active hazard{minSeverity || clientId ? ' with these filters' : ''}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
