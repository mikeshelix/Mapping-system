/**
 * Outbound message providers. Everything that sends goes through these
 * interfaces so the email or SMS vendor can be swapped without touching the engine.
 */
import { log } from './util';

export interface OutboundEmail {
  to: string;
  subject: string;
  html: string | null;
  text: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: OutboundEmail): Promise<{ messageId: string | null }>;
}

/** Phase 2. Declared now so rules and the notifications table already speak in channels. */
export interface SmsProvider {
  readonly name: string;
  send(message: { to: string; text: string }): Promise<{ messageId: string | null }>;
}

/**
 * Brevo transactional email.
 * Docs: https://developers.brevo.com/reference/sendtransacemail
 */
export class BrevoEmailProvider implements EmailProvider {
  readonly name = 'brevo';
  constructor(
    private apiKey: string,
    private from: { email: string; name: string },
  ) {}

  async send(message: OutboundEmail): Promise<{ messageId: string | null }> {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: this.from,
        to: [{ email: message.to }],
        subject: message.subject,
        htmlContent: message.html ?? `<pre>${message.text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`,
        textContent: message.text,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Brevo returned HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json().catch(() => ({}))) as { messageId?: string };
    return { messageId: json.messageId ?? null };
  }
}

/** Development fallback: writes the message to the log instead of sending it. */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';
  async send(message: OutboundEmail): Promise<{ messageId: string | null }> {
    log('info', 'email (not sent: no BREVO_API_KEY)', { to: message.to, subject: message.subject });
    return { messageId: null };
  }
}

export function createEmailProvider(): EmailProvider {
  const key = process.env.BREVO_API_KEY;
  if (!key) return new ConsoleEmailProvider();
  return new BrevoEmailProvider(key, {
    email: process.env.EMAIL_FROM_ADDRESS || 'alerts@example.com',
    name: process.env.EMAIL_FROM_NAME || 'Weather Alerts',
  });
}
