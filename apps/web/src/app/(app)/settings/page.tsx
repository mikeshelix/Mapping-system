import { EXPOSURE_NOTE, NOTIFIABLE_SEVERITIES, readExposureFactors, SEVERITY_LABELS, SOURCE_NAMES, type SourceId } from '@hazard/core';
import { getSql, readSmsCaps } from '@hazard/db';
import { requireAdmin } from '@/lib/auth';
import { Flash, type Search } from '@/components/Flash';
import { saveExposureFactors, saveFeedSetting, saveSmsCaps } from '@/app/actions/settings';

const BUFFER_HELP: Partial<Record<SourceId, string>> = {
  spc: 'around each storm report',
  wfigs: 'beyond each fire perimeter',
  firms: 'around each satellite detection',
  nwps: 'around each river gauge in flood',
};

export default async function SettingsPage({ searchParams }: { searchParams: Search }) {
  const admin = await requireAdmin();
  const sql = getSql();
  const [[org], feeds, [usage]] = await Promise.all([
    sql`SELECT settings FROM organizations WHERE id = ${admin.organizationId}`,
    sql`SELECT feed, enabled, buffer_meters FROM feed_settings ORDER BY feed`,
    sql`
      SELECT count(*) FILTER (WHERE status <> 'skipped')::int AS sent_today, count(*) FILTER (WHERE status = 'skipped')::int AS held_today
      FROM notifications
      WHERE organization_id = ${admin.organizationId} AND channel = 'sms' AND created_at >= date_trunc('day', now())`,
  ]);
  const caps = readSmsCaps(org?.settings);
  const factors = readExposureFactors(org?.settings);
  const smsConnected = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && (process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_MESSAGING_SERVICE_SID));

  return (
    <div className="page">
      <h1>Settings</h1>
      <Flash search={searchParams} />
      <div className="card">
        <h2>Text messages</h2>
        <p className={smsConnected ? 'muted' : 'flash error'}>
          {smsConnected
            ? 'A text message provider is connected.'
            : 'No text message provider is connected, so no texts are sent. Email is unaffected.'}
        </p>
        <form action={saveSmsCaps} className="grid">
          <label>
            Most texts for any one hazard
            <input type="number" name="per_event" min={0} max={100000} defaultValue={caps.perEvent} required />
          </label>
          <label>
            Most texts in one day
            <input type="number" name="per_day" min={0} max={100000} defaultValue={caps.perDay} required />
          </label>
          <button type="submit">Save caps</button>
        </form>
        <p className="small muted">
          Today (UTC): {usage!.sent_today} sent or queued, {usage!.held_today} held back by a cap. A text held back by
          a cap is listed under Notifications as skipped and is not retried; the contact still gets the email. Texts
          only ever go to contacts who have agreed to receive them, and a reply of STOP ends them.
        </p>
      </div>

      <div className="card">
        <h2>Estimated exposure</h2>
        <p className="muted">
          Percentage of a property&apos;s declared value counted as exposed, by the severity of the hazard affecting it.
        </p>
        <form action={saveExposureFactors} className="grid">
          {NOTIFIABLE_SEVERITIES.map((s) => (
            <label key={s}>
              {SEVERITY_LABELS[s]} (%)
              <input type="number" name={`factor_${s}`} min={0} max={100} step="0.1" defaultValue={Math.round(factors[s] * 1000) / 10} required />
            </label>
          ))}
          <button type="submit">Save percentages</button>
        </form>
        <p className="small muted">{EXPOSURE_NOTE}</p>
      </div>

      <div className="card">
        <h2>Hazard feeds</h2>
        {!admin.isPlatformAdmin && <p className="muted">These apply to every organization and can only be changed by platform administrators.</p>}
        <table>
          <thead>
            <tr>
              <th>Feed</th>
              <th>On</th>
              <th>Matching distance</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {feeds.map((f) => (
              <tr key={f.feed}>
                <td>
                  {String(f.feed).toUpperCase()}
                  <div className="small muted">{SOURCE_NAMES[f.feed as SourceId] ?? ''}</div>
                </td>
                <td colSpan={3}>
                  <form action={saveFeedSetting} className="row">
                    <input type="hidden" name="feed" value={f.feed} />
                    <label className="check">
                      <input type="checkbox" name="enabled" defaultChecked={f.enabled} disabled={!admin.isPlatformAdmin} /> Enabled
                    </label>
                    {f.buffer_meters !== null ? (
                      <label className="check">
                        <input
                          type="number"
                          name="buffer_miles"
                          step="0.1"
                          min={0}
                          max={100}
                          defaultValue={Math.round((f.buffer_meters / 1609.344) * 10) / 10}
                          style={{ width: 90 }}
                          disabled={!admin.isPlatformAdmin}
                        />
                        miles {BUFFER_HELP[f.feed as SourceId] ?? ''}
                      </label>
                    ) : (
                      <span className="muted small" style={{ minWidth: 260 }}>
                        {f.feed === 'usgs' ? 'Radius set by magnitude' : 'Uses the area the source provides'}
                      </span>
                    )}
                    {admin.isPlatformAdmin && (
                      <button type="submit" className="secondary">
                        Save
                      </button>
                    )}
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
