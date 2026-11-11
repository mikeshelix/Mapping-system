import { severityRank, type Severity } from './severity';

export type Channel = 'email' | 'sms';

export interface RuleInput {
  id: string;
  organizationId: string;
  enabled: boolean;
  /** Empty means every hazard type. */
  hazardTypes: string[];
  minSeverity: Severity;
  scope: 'all' | 'clients' | 'properties';
  clientIds: string[];
  propertyIds: string[];
  recipientMode: 'linked' | 'specific';
  contactIds: string[];
  channels: Channel[];
}

export interface ImpactInput {
  propertyId: string;
  clientId: string;
  organizationId: string;
}

export interface ContactInput {
  id: string;
  organizationId: string;
  clientId: string | null;
  /** When non-empty, the contact only hears about these properties. */
  propertyIds: string[];
  email: string | null;
  mobile: string | null;
  smsOptIn: boolean;
}

export interface PlannedNotification {
  organizationId: string;
  contactId: string;
  channel: Channel;
  /** The first rule that selected this contact, kept for the audit trail. */
  ruleId: string;
  propertyIds: string[];
  severity: Severity;
  /** True when at least one listed property was already notified at a lower severity. */
  isEscalation: boolean;
}

export function notifiedKey(contactId: string, propertyId: string, channel: Channel): string {
  return `${contactId}|${propertyId}|${channel}`;
}

export function ruleMatchesEvent(rule: RuleInput, event: { hazardType: string; severity: Severity }): boolean {
  if (!rule.enabled) return false;
  if (event.severity === 'unknown') return false;
  if (rule.hazardTypes.length > 0 && !rule.hazardTypes.includes(event.hazardType)) return false;
  return severityRank(event.severity) >= severityRank(rule.minSeverity);
}

export function ruleCoversImpact(rule: RuleInput, impact: ImpactInput): boolean {
  if (rule.organizationId !== impact.organizationId) return false;
  if (rule.scope === 'clients') return rule.clientIds.includes(impact.clientId);
  if (rule.scope === 'properties') return rule.propertyIds.includes(impact.propertyId);
  return true;
}

function contactIsLinked(contact: ContactInput, impact: ImpactInput): boolean {
  if (contact.organizationId !== impact.organizationId) return false;
  if (contact.propertyIds.length > 0) return contact.propertyIds.includes(impact.propertyId);
  return contact.clientId !== null && contact.clientId === impact.clientId;
}

function canReceive(contact: ContactInput, channel: Channel): boolean {
  if (channel === 'email') return !!contact.email;
  // SMS only ever goes to contacts with a recorded opt-in.
  return !!contact.mobile && contact.smsOptIn;
}

export interface PlanInput {
  event: { hazardType: string; severity: Severity };
  impacts: ImpactInput[];
  rules: RuleInput[];
  contacts: ContactInput[];
  /** notifiedKey() -> highest severity already sent for this event. */
  alreadyNotified: ReadonlyMap<string, Severity>;
  /** Channels that are switched on. Phase 1 is email only. */
  enabledChannels?: Channel[];
}

/**
 * Work out which messages an event should produce.
 *
 * Guarantees:
 *  - unknown-severity events produce nothing
 *  - one message per contact per channel, listing all of their affected properties
 *  - a property already notified is repeated only if the severity has risen
 */
export function planNotifications(input: PlanInput): PlannedNotification[] {
  const { event, impacts, rules, contacts, alreadyNotified } = input;
  const enabledChannels = input.enabledChannels ?? ['email'];
  if (event.severity === 'unknown') return [];

  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const plans = new Map<string, PlannedNotification & { escalated: boolean }>();

  for (const rule of rules) {
    if (!ruleMatchesEvent(rule, event)) continue;
    const channels = rule.channels.filter((c) => enabledChannels.includes(c));
    if (channels.length === 0) continue;

    for (const impact of impacts) {
      if (!ruleCoversImpact(rule, impact)) continue;

      const recipients =
        rule.recipientMode === 'specific'
          ? rule.contactIds
              .map((id) => contactsById.get(id))
              .filter((c): c is ContactInput => !!c && c.organizationId === impact.organizationId)
          : contacts.filter((c) => contactIsLinked(c, impact));

      for (const contact of recipients) {
        for (const channel of channels) {
          if (!canReceive(contact, channel)) continue;

          const prior = alreadyNotified.get(notifiedKey(contact.id, impact.propertyId, channel));
          if (prior && severityRank(event.severity) <= severityRank(prior)) continue;

          const key = `${contact.id}|${channel}`;
          let plan = plans.get(key);
          if (!plan) {
            plan = {
              organizationId: impact.organizationId,
              contactId: contact.id,
              channel,
              ruleId: rule.id,
              propertyIds: [],
              severity: event.severity,
              isEscalation: false,
              escalated: false,
            };
            plans.set(key, plan);
          }
          if (!plan.propertyIds.includes(impact.propertyId)) plan.propertyIds.push(impact.propertyId);
          if (prior) plan.escalated = true;
        }
      }
    }
  }

  return [...plans.values()].map(({ escalated, ...plan }) => ({ ...plan, isEscalation: escalated }));
}
