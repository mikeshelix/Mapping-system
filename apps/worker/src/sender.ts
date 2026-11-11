import { getFeedHealth, type Sql } from '@hazard/db';
import type { EmailProvider, SmsProvider } from './providers';
import { backoffMs, errorMessage, log } from './util';

const MAX_ATTEMPTS = 5;

/** Send queued notifications. Every attempt is recorded on the notification row. */
export async function sendQueued(sql: Sql, email: EmailProvider, sms: SmsProvider | null, batchSize = 25): Promise<number> {
  // Anything left in 'sending' for 10 minutes was interrupted mid-send; put it back.
  await sql`
    UPDATE notifications SET status = 'queued'
    WHERE status = 'sending' AND next_attempt_at < now() - interval '10 minutes'`;

  const claimed = await sql`
    UPDATE notifications SET status = 'sending', attempts = attempts + 1, next_attempt_at = now()
    WHERE id IN (
      SELECT id FROM notifications WHERE status = 'queued' AND next_attempt_at <= now()
      ORDER BY created_at LIMIT ${batchSize} FOR UPDATE SKIP LOCKED)
    RETURNING id, channel, contact_id, recipient, subject, body_html, body_text, attempts`;

  let sent = 0;
  for (const n of claimed) {
    const provider = n.channel === 'sms' ? sms : email;
    try {
      let result: { messageId: string | null };
      if (n.channel === 'sms') {
        if (!sms) throw new Error('Text messaging is not configured');
        // Re-check consent at the moment of sending: the contact may have replied STOP since this was queued.
        const [contact] = await sql`SELECT sms_opt_in, sms_opt_out_at, mobile FROM contacts WHERE id = ${n.contact_id}`;
        if (!contact || !contact.sms_opt_in || contact.sms_opt_out_at || contact.mobile !== n.recipient) {
          await sql`
            UPDATE notifications SET status = 'skipped', error = 'Not sent: the contact has no current text message opt-in.'
            WHERE id = ${n.id}`;
          continue;
        }
        result = await sms.send({ to: n.recipient, text: n.body_text });
      } else {
        result = await email.send({ to: n.recipient, subject: n.subject ?? 'Hazard alert', html: n.body_html, text: n.body_text });
      }
      await sql`
        UPDATE notifications SET status = 'sent', sent_at = now(), provider = ${provider?.name ?? null},
          provider_message_id = ${result.messageId}, error = NULL
        WHERE id = ${n.id}`;
      sent++;
    } catch (err) {
      const final = n.attempts >= MAX_ATTEMPTS;
      const delaySeconds = Math.round(backoffMs(n.attempts, 30_000, 30 * 60_000) / 1000);
      await sql`
        UPDATE notifications SET status = ${final ? 'failed' : 'queued'}, provider = ${provider?.name ?? null},
          error = ${errorMessage(err)}, next_attempt_at = now() + make_interval(secs => ${delaySeconds})
        WHERE id = ${n.id}`;
      log('error', 'notification send failed', { id: n.id, attempt: n.attempts, final, error: errorMessage(err) });
    }
  }
  return sent;
}

/**
 * If a feed has gone stale, email the platform admins once per stale episode.
 * (The web app shows a banner from the same feed_status rows.)
 */
export async function alertOnStaleFeeds(sql: Sql): Promise<void> {
  const stale = (await getFeedHealth(sql)).filter((f) => f.stale && !f.staleAlertedAt);
  if (stale.length === 0) return;
  const admins = await sql`SELECT email FROM users WHERE is_platform_admin`;
  for (const feed of stale) {
    const last = feed.lastSuccessAt ? feed.lastSuccessAt.toISOString() : 'never';
    const text = [
      `The "${feed.feed}" hazard feed has not updated successfully since ${last}.`,
      `Threshold: ${feed.staleAfterSeconds} seconds. Consecutive failures: ${feed.consecutiveFailures}.`,
      feed.lastError ? `Last error: ${feed.lastError}` : null,
      '',
      'Alerts from this feed may be delayed or missing until it recovers.',
    ]
      .filter((l) => l !== null)
      .join('\n');
    await sql.begin(async (tx) => {
      for (const admin of admins) {
        await tx`
          INSERT INTO notifications (kind, channel, recipient, subject, body_text)
          VALUES ('system', 'email', ${admin.email}, ${`Feed stale: ${feed.feed}`}, ${text})`;
      }
      await tx`UPDATE feed_status SET stale_alerted_at = now() WHERE feed = ${feed.feed}`;
    });
    log('warn', 'feed stale', { feed: feed.feed, lastSuccessAt: last, adminsNotified: admins.length });
  }
}
