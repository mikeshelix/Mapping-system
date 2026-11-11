import Link from 'next/link';
import type { Severity } from '@hazard/core';
import { getSql } from '@hazard/db';
import { requireUser } from '@/lib/auth';
import { SeverityPill, when } from '@/components/Flash';

export default async function NotificationsPage() {
  const user = await requireUser();
  const rows = await getSql()`
    SELECT n.id, n.created_at, n.sent_at, n.channel, n.recipient, n.subject, n.status, n.attempts, n.error, n.severity,
      n.is_escalation, n.hazard_event_id, k.name AS contact_name,
      (SELECT count(*)::int FROM notification_properties np WHERE np.notification_id = n.id) AS properties
    FROM notifications n LEFT JOIN contacts k ON k.id = n.contact_id
    WHERE n.organization_id = ${user.organizationId}
    ORDER BY n.created_at DESC LIMIT 300`;

  return (
    <div className="page">
      <h1>Notifications</h1>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Queued</th>
              <th>To</th>
              <th>Message</th>
              <th>Severity</th>
              <th>Properties</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.id} className={n.status === 'failed' ? 'bad' : ''}>
                <td>{when(n.created_at)}</td>
                <td>
                  {n.contact_name}
                  <div className="small muted">
                    {n.channel}: {n.recipient}
                  </div>
                </td>
                <td>{n.hazard_event_id ? <Link href={`/?event=${n.hazard_event_id}`}>{n.subject}</Link> : n.subject}</td>
                <td>{n.severity && <SeverityPill severity={n.severity as Severity} />}</td>
                <td>{n.properties}</td>
                <td>
                  {n.status}
                  {n.status === 'sent' && <div className="small muted">{when(n.sent_at)}</div>}
                  {n.error && (
                    <div className="small muted">
                      Attempt {n.attempts}: {n.error}
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Nothing has been sent yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
