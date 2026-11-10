import { getFeedHealth, getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { when } from '@/components/Flash';

export default async function FeedsPage() {
  await requireUser();
  const sql = getSql();
  const [feeds, runs, [counts]] = await Promise.all([
    getFeedHealth(sql),
    sql`SELECT * FROM ingestion_runs ORDER BY id DESC LIMIT 50`,
    sql`SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*)::int AS total,
          (SELECT count(*)::int FROM geo_zones) AS zones FROM hazard_events`,
  ]);

  return (
    <div className="page">
      <h1>Hazard feeds</h1>
      <div className="card stats">
        <div>
          <strong>{counts!.active.toLocaleString()}</strong>active events nationwide
        </div>
        <div>
          <strong>{counts!.total.toLocaleString()}</strong>events stored
        </div>
        <div>
          <strong>{counts!.zones.toLocaleString()}</strong>zone shapes cached
        </div>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Feed</th>
              <th>Status</th>
              <th>Last success</th>
              <th>Last attempt</th>
              <th>Stale after</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {feeds.map((f) => (
              <tr key={f.feed} className={f.stale ? 'bad' : ''}>
                <td>{f.feed.toUpperCase()}</td>
                <td>{f.stale ? 'Stale' : 'Healthy'}</td>
                <td>{when(f.lastSuccessAt) || 'never'}</td>
                <td>{when(f.lastAttemptAt)}</td>
                <td>{Math.round(f.staleAfterSeconds / 60)} min</td>
                <td>{f.lastError}</td>
              </tr>
            ))}
            {feeds.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No feed has run yet. Start the worker.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>Recent ingestion runs</h2>
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Feed</th>
              <th>Result</th>
              <th>Seen</th>
              <th>New</th>
              <th>Updated</th>
              <th>Cancelled</th>
              <th>Expired</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className={r.status === 'error' ? 'bad' : ''}>
                <td>{when(r.started_at)}</td>
                <td>{String(r.feed).toUpperCase()}</td>
                <td>{r.status === 'not_modified' ? 'no change' : r.status}</td>
                <td>{r.events_seen}</td>
                <td>{r.events_new}</td>
                <td>{r.events_updated}</td>
                <td>{r.events_cancelled}</td>
                <td>{r.events_expired}</td>
                <td>{r.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
