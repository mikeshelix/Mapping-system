import { SEVERITY_COLORS, SEVERITY_LABELS, type Severity } from './severity';

export const DISCLAIMER =
  'These alerts supplement official warnings and do not replace them. Always follow instructions from the National Weather Service and local emergency officials.';

export interface MessageInput {
  eventName: string;
  severity: Severity;
  headline: string | null;
  instruction: string | null;
  areaDesc: string | null;
  /** Human name of the issuing source, e.g. "National Weather Service". */
  sourceName: string;
  sourceUrl: string | null;
  endsAt: string | null;
  isEscalation: boolean;
  contactName: string;
  properties: Array<{ name: string; address: string | null; clientName: string }>;
  mapUrl: string;
}

export interface RenderedMessage {
  subject: string;
  html: string;
  text: string;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
}

export function renderHazardEmail(m: MessageInput): RenderedMessage {
  const sev = SEVERITY_LABELS[m.severity];
  const count = m.properties.length;
  const noun = count === 1 ? 'property' : 'properties';
  const prefix = m.isEscalation ? 'UPGRADED: ' : '';
  const subject = `${prefix}${m.eventName} (${sev}) - ${count} ${noun} affected`;
  const until = formatTime(m.endsAt);

  const textLines = [
    `${prefix}${m.eventName}`,
    `Severity: ${sev}`,
    `Issued by: ${m.sourceName}`,
    until ? `In effect until: ${until}` : null,
    m.areaDesc ? `Area: ${m.areaDesc}` : null,
    '',
    m.headline ?? null,
    m.instruction ? `\nWhat to do: ${m.instruction}` : null,
    '',
    `Affected ${noun} (${count}):`,
    ...m.properties.map((p) => `  - ${p.name}${p.address ? `, ${p.address}` : ''} [${p.clientName}]`),
    '',
    `View on the map: ${m.mapUrl}`,
    m.sourceUrl ? `Official alert: ${m.sourceUrl}` : null,
    '',
    DISCLAIMER,
  ].filter((l): l is string => l !== null);

  const rows = m.properties
    .map(
      (p) =>
        `<tr><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${esc(p.name)}</td>` +
        `<td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${esc(p.address ?? '')}</td>` +
        `<td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${esc(p.clientName)}</td></tr>`,
    )
    .join('');

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;max-width:640px">
<p>Hello ${esc(m.contactName)},</p>
<div style="border-left:6px solid ${SEVERITY_COLORS[m.severity]};padding:8px 12px;background:#f9fafb">
<div style="font-size:18px;font-weight:bold">${esc(prefix + m.eventName)}</div>
<div>Severity: <strong>${sev}</strong></div>
<div>Issued by: ${esc(m.sourceName)}</div>
${until ? `<div>In effect until: ${esc(until)}</div>` : ''}
${m.areaDesc ? `<div>Area: ${esc(m.areaDesc)}</div>` : ''}
</div>
${m.headline ? `<p>${esc(m.headline)}</p>` : ''}
${m.instruction ? `<p><strong>What to do:</strong> ${esc(m.instruction)}</p>` : ''}
<p><strong>Affected ${noun} (${count})</strong></p>
<table style="border-collapse:collapse;width:100%;font-size:13px">
<tr><th align="left" style="padding:6px 8px;border-bottom:2px solid #d1d5db">Property</th><th align="left" style="padding:6px 8px;border-bottom:2px solid #d1d5db">Address</th><th align="left" style="padding:6px 8px;border-bottom:2px solid #d1d5db">Client</th></tr>
${rows}
</table>
<p><a href="${esc(m.mapUrl)}">View on the map</a>${m.sourceUrl ? ` &nbsp;|&nbsp; <a href="${esc(m.sourceUrl)}">Official alert</a>` : ''}</p>
<p style="font-size:12px;color:#6b7280">${esc(DISCLAIMER)}</p>
</div>`;

  return { subject, html, text: textLines.join('\n') };
}

/**
 * Text-message version: short, but still states hazard, severity, properties, source,
 * map link, the disclaimer and how to opt out.
 */
export function renderHazardSms(m: Pick<MessageInput, 'eventName' | 'severity' | 'sourceName' | 'isEscalation' | 'properties' | 'mapUrl'>): string {
  const count = m.properties.length;
  const names = m.properties.slice(0, 2).map((p) => p.name).join(', ');
  const more = count > 2 ? ` +${count - 2} more` : '';
  return (
    `${m.isEscalation ? 'UPGRADED: ' : ''}${m.eventName} (${SEVERITY_LABELS[m.severity]}) affects ` +
    `${count} propert${count === 1 ? 'y' : 'ies'}: ${names}${more}. Source: ${m.sourceName}. Map: ${m.mapUrl} ` +
    `Supplements, does not replace, official warnings. Reply STOP to opt out.`
  );
}
