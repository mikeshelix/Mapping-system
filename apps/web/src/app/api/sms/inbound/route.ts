/**
 * Twilio inbound-message webhook. Records every reply and honours STOP / START.
 *
 * Twilio itself also blocks further sends to a number that replied STOP; this
 * keeps our own record in step so we stop queueing texts for that contact and
 * can show the opt-out and its date.
 *
 * Configure the number's (or Messaging Service's) "A message comes in" webhook to
 * POST to TWILIO_WEBHOOK_URL. Requests are verified with Twilio's signature.
 */
import twilio from 'twilio';
import { classifyInboundSms, normalizeUsPhone } from '@hazard/core';
import { getSql } from '@hazard/db';

export const dynamic = 'force-dynamic';

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const xml = (status = 200) => new Response(EMPTY_TWIML, { status, headers: { 'Content-Type': 'text/xml' } });

export async function POST(request: Request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const url = process.env.TWILIO_WEBHOOK_URL;
  if (!authToken || !url) return new Response('SMS is not configured', { status: 503 });

  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) if (typeof value === 'string') params[key] = value;

  const signature = request.headers.get('x-twilio-signature') ?? '';
  if (!twilio.validateRequest(authToken, signature, url, params)) return new Response('Invalid signature', { status: 403 });

  const from = normalizeUsPhone(params.From ?? '') ?? params.From ?? '';
  const body = params.Body ?? '';
  const action = classifyInboundSms(body, params.OptOutType);
  const sql = getSql();

  let updated = 0;
  if (from && action === 'stop') {
    updated = (await sql`
      UPDATE contacts SET sms_opt_in = false, sms_opt_out_at = now() WHERE mobile = ${from} RETURNING id`).length;
    // Drop anything still waiting to go to this number.
    await sql`
      UPDATE notifications SET status = 'skipped', error = 'Not sent: the contact replied STOP.'
      WHERE channel = 'sms' AND recipient = ${from} AND status = 'queued'`;
  } else if (from && action === 'start') {
    updated = (await sql`
      UPDATE contacts SET sms_opt_in = true, sms_opt_in_at = now(), sms_opt_out_at = NULL WHERE mobile = ${from} RETURNING id`).length;
  }
  await sql`
    INSERT INTO sms_events (from_number, body, action, contacts_updated)
    VALUES (${from}, ${body.slice(0, 1000)}, ${action}, ${updated})`;

  // Twilio sends its own confirmation for STOP / START / HELP, so we reply with nothing.
  return xml();
}
