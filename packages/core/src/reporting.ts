/**
 * Phase 3: rule templates, rule preview (replay) and exposure estimates. All pure.
 */
import type { HazardType } from './nws';
import { notifiedKey, planNotifications, type Channel, type ContactInput, type ImpactInput, type RuleInput } from './rules';
import { severityRank, type Severity } from './severity';

// ------------------------------------------------------------------ rule templates

export interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  hazardTypes: HazardType[];
  minSeverity: Exclude<Severity, 'unknown'>;
}

/** Starting points for the rule builder. Every field can be changed before saving. */
export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: 'severe_storms',
    name: 'Tornado and severe storms',
    description: 'Tornado and severe thunderstorm warnings, damaging wind and large hail.',
    hazardTypes: ['tornado', 'severe_thunderstorm', 'wind', 'hail'],
    minSeverity: 'severe',
  },
  {
    id: 'hail',
    name: 'Hail damage',
    description: 'Radar-estimated and reported hail of one inch or larger: the size that damages roofs.',
    hazardTypes: ['hail'],
    minSeverity: 'moderate',
  },
  {
    id: 'hurricane',
    name: 'Hurricane and tropical storm',
    description: 'Forecast cones, wind fields, tropical warnings and coastal flooding.',
    hazardTypes: ['hurricane', 'coastal'],
    minSeverity: 'moderate',
  },
  {
    id: 'flood',
    name: 'Flooding',
    description: 'Flood and flash flood warnings, and river gauges in flood.',
    hazardTypes: ['flood', 'flash_flood', 'coastal'],
    minSeverity: 'moderate',
  },
  {
    id: 'wildfire',
    name: 'Wildfire',
    description: 'Wildfire perimeters, satellite fire detections and red flag warnings.',
    hazardTypes: ['wildfire', 'fire'],
    minSeverity: 'moderate',
  },
  {
    id: 'winter',
    name: 'Winter storm and freeze',
    description: 'Winter storm, ice and blizzard warnings, and hard freezes (burst-pipe weather).',
    hazardTypes: ['winter', 'cold'],
    minSeverity: 'severe',
  },
  {
    id: 'earthquake',
    name: 'Earthquake',
    description: 'Earthquakes of magnitude 4 and above near a property.',
    hazardTypes: ['earthquake'],
    minSeverity: 'moderate',
  },
  {
    id: 'fema',
    name: 'FEMA declarations',
    description: 'A disaster or emergency is declared for a county with properties in it.',
    hazardTypes: ['disaster_declaration'],
    minSeverity: 'moderate',
  },
  {
    id: 'everything_severe',
    name: 'Anything severe',
    description: 'Every hazard type, once it reaches severe.',
    hazardTypes: [],
    minSeverity: 'severe',
  },
];

// ------------------------------------------------------------------ rule preview (replay)

export interface ReplayEvent {
  id: string;
  hazardType: string;
  eventName: string;
  firstSeenAt: string;
  /** Severity of each stored version of the event, oldest first. */
  severities: Severity[];
  /** Properties of this organization inside the event's area. */
  impacts: ImpactInput[];
}

export interface RulePreview {
  /** Stored events in the window that touched at least one property. */
  eventsConsidered: number;
  /** Of those, events the rule would have acted on. */
  eventsMatched: number;
  propertiesAffected: number;
  contactsNotified: number;
  messages: Record<Channel, number>;
  /** Messages that were follow-ups after a severity increase (included in `messages`). */
  followUps: number;
  byHazard: Array<{ hazardType: string; events: number; messages: number }>;
  /** The events that would have produced the most messages. */
  busiest: Array<{ id: string; eventName: string; firstSeenAt: string; severity: Severity; properties: number; messages: number }>;
}

/**
 * Replay stored events through one rule and count what it would have sent.
 *
 * Follows the live engine exactly: one message per contact per event per channel,
 * and a follow-up only when a later version of the event has a higher severity.
 * Send caps are not applied.
 */
export function replayRule(rule: RuleInput, contacts: ContactInput[], events: ReplayEvent[], channels: Channel[] = ['email', 'sms']): RulePreview {
  const properties = new Set<string>();
  const reached = new Set<string>();
  const messages: Record<Channel, number> = { email: 0, sms: 0 };
  const byHazard = new Map<string, { hazardType: string; events: number; messages: number }>();
  const perEvent: RulePreview['busiest'] = [];
  let followUps = 0;
  let eventsMatched = 0;
  const activeRule = { ...rule, enabled: true };

  for (const event of events) {
    const already = new Map<string, Severity>();
    const eventProperties = new Set<string>();
    let eventMessages = 0;
    let peak: Severity = 'unknown';
    let highest = -1;
    for (const severity of event.severities) {
      // Only a rise in severity can produce anything new.
      if (severityRank(severity) <= highest) continue;
      highest = severityRank(severity);
      const plans = planNotifications({
        event: { hazardType: event.hazardType, severity },
        impacts: event.impacts,
        rules: [activeRule],
        contacts,
        alreadyNotified: already,
        enabledChannels: channels,
      });
      for (const plan of plans) {
        messages[plan.channel]++;
        eventMessages++;
        if (plan.isEscalation) followUps++;
        reached.add(plan.contactId);
        peak = severity;
        for (const propertyId of plan.propertyIds) {
          already.set(notifiedKey(plan.contactId, propertyId, plan.channel), severity);
          eventProperties.add(propertyId);
          properties.add(propertyId);
        }
      }
    }
    if (eventMessages === 0) continue;
    eventsMatched++;
    const bucket = byHazard.get(event.hazardType) ?? { hazardType: event.hazardType, events: 0, messages: 0 };
    bucket.events++;
    bucket.messages += eventMessages;
    byHazard.set(event.hazardType, bucket);
    perEvent.push({ id: event.id, eventName: event.eventName, firstSeenAt: event.firstSeenAt, severity: peak, properties: eventProperties.size, messages: eventMessages });
  }

  return {
    eventsConsidered: events.length,
    eventsMatched,
    propertiesAffected: properties.size,
    contactsNotified: reached.size,
    messages,
    followUps,
    byHazard: [...byHazard.values()].sort((a, b) => b.messages - a.messages),
    busiest: perEvent.sort((a, b) => b.messages - a.messages || b.properties - a.properties).slice(0, 8),
  };
}

// ------------------------------------------------------------------ exposure estimate

/** Share of a property's declared value assumed to be at risk, per severity. */
export type ExposureFactors = Record<Exclude<Severity, 'unknown'>, number>;

/**
 * Starting assumptions, changeable by an admin. These are planning figures, not
 * loss predictions: actual damage depends on the building, the hazard and luck.
 */
export const DEFAULT_EXPOSURE_FACTORS: ExposureFactors = { minor: 0.01, moderate: 0.05, severe: 0.15, extreme: 0.4 };

export function readExposureFactors(settings: unknown): ExposureFactors {
  const stored = ((settings ?? {}) as { exposureFactors?: Record<string, unknown> }).exposureFactors ?? {};
  const out = { ...DEFAULT_EXPOSURE_FACTORS };
  for (const key of Object.keys(out) as Array<keyof ExposureFactors>) {
    const v = stored[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) out[key] = v;
  }
  return out;
}

/**
 * Estimated dollar exposure: declared value x the factor for the severity.
 * Null when there is no declared value; zero for unknown severity.
 */
export function estimateExposure(declaredValue: number | string | null | undefined, severity: Severity, factors: ExposureFactors): number | null {
  if (declaredValue === null || declaredValue === undefined || declaredValue === '') return null;
  const value = Number(declaredValue);
  if (!Number.isFinite(value) || value < 0) return null;
  if (severity === 'unknown') return 0;
  return Math.round(value * factors[severity] * 100) / 100;
}

export const EXPOSURE_NOTE =
  'Estimate only: declared value multiplied by an assumed percentage for the hazard severity. It is not a damage assessment or a prediction of loss.';

// ------------------------------------------------------------------ CSV output

/**
 * One CSV cell. Quotes when needed, and neutralizes values a spreadsheet would
 * run as a formula (leading = + - @), since names and addresses come from uploads.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
