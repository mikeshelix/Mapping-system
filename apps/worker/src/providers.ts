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

/**
 * Twilio SMS.
 * Docs: https://www.twilio.com/docs/messaging/api/message-resource
 * Twilio itself blocks sends to numbers that replied STOP (error 21610).
 */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  constructor(
    private accountSid: string,
    private authToken: string,
    private sender: { from?: string; messagingServiceSid?: string },
  ) {}

  async send(message: { to: string; text: string }): Promise<{ messageId: string | null }> {
    const body = new URLSearchParams({ To: message.to, Body: message.text });
    if (this.sender.messagingServiceSid) body.set('MessagingServiceSid', this.sender.messagingServiceSid);
    else if (this.sender.from) body.set('From', this.sender.from);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
    if (!res.ok) throw new Error(`Twilio returned HTTP ${res.status}${json.code ? ` (code ${json.code})` : ''}: ${json.message ?? ''}`);
    return { messageId: json.sid ?? null };
  }
}

/** Null when Twilio is not configured; SMS then stays switched off everywhere. */
export function createSmsProvider(): SmsProvider | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const service = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!sid || !token || !(from || service)) return null;
  return new TwilioSmsProvider(sid, token, { from, messagingServiceSid: service });
}

export function createEmailProvider(): EmailProvider {
  const key = process.env.BREVO_API_KEY;
  if (!key) return new ConsoleEmailProvider();
  return new BrevoEmailProvider(key, {
    email: process.env.EMAIL_FROM_ADDRESS || 'alerts@example.com',
    name: process.env.EMAIL_FROM_NAME || 'Weather Alerts',
  });
}
