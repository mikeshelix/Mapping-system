import { describe, expect, it } from 'vitest';
import {
  classifyNwsEvent,
  decideIngest,
  DISCLAIMER,
  mapNwsSeverity,
  maxSeverity,
  normalizeNwsAlert,
  notifiedKey,
  parseBatchResponse,
  buildBatchCsv,
  planNotifications,
  renderHazardEmail,
  severityRank,
  type ContactInput,
  type ImpactInput,
  type NwsAlertFeature,
  type RuleInput,
  type Severity,
} from './index';

// ------------------------------------------------------------ severity mapping
describe('severity mapping', () => {
  it('maps every NWS severity onto the common scale', () => {
    expect(mapNwsSeverity('Extreme')).toBe('extreme');
    expect(mapNwsSeverity('Severe')).toBe('severe');
    expect(mapNwsSeverity('Moderate')).toBe('moderate');
    expect(mapNwsSeverity('Minor')).toBe('minor');
    expect(mapNwsSeverity('Unknown')).toBe('unknown');
  });

  it('is case and whitespace insensitive', () => {
    expect(mapNwsSeverity(' SEVERE ')).toBe('severe');
    expect(mapNwsSeverity('extreme')).toBe('extreme');
  });

  it('treats missing or unrecognized values as unknown, never as a real severity', () => {
    expect(mapNwsSeverity(null)).toBe('unknown');
    expect(mapNwsSeverity(undefined)).toBe('unknown');
    expect(mapNwsSeverity('')).toBe('unknown');
    expect(mapNwsSeverity('Catastrophic')).toBe('unknown');
  });

  it('ranks unknown < minor < moderate < severe < extreme', () => {
    const order: Severity[] = ['unknown', 'minor', 'moderate', 'severe', 'extreme'];
    for (let i = 1; i < order.length; i++) {
      expect(severityRank(order[i]!)).toBeGreaterThan(severityRank(order[i - 1]!));
    }
    expect(maxSeverity('minor', 'severe')).toBe('severe');
    expect(maxSeverity('extreme', 'severe')).toBe('extreme');
  });
});

// ------------------------------------------------------------ NWS normalization
function feature(overrides: Partial<NwsAlertFeature['properties']> = {}, geometry: NwsAlertFeature['geometry'] = null): NwsAlertFeature {
  return {
    id: 'https://api.weather.gov/alerts/urn:oid:A.1',
    geometry,
    properties: {
      '@id': 'https://api.weather.gov/alerts/urn:oid:A.1',
      id: 'urn:oid:A.1',
      areaDesc: 'Harris, TX',
      geocode: { UGC: ['TXC201'] },
      affectedZones: ['https://api.weather.gov/zones/county/TXC201'],
      references: [],
      sent: '2026-11-10T12:00:00-06:00',
      effective: '2026-11-10T12:00:00-06:00',
      onset: '2026-11-10T13:00:00-06:00',
      expires: '2026-11-10T18:00:00-06:00',
      ends: '2026-11-10T20:00:00-06:00',
      status: 'Actual',
      messageType: 'Alert',
      severity: 'Severe',
      event: 'Tornado Warning',
      headline: 'Tornado Warning issued',
      description: 'desc',
      instruction: 'Take cover',
      ...overrides,
    },
  };
}

describe('NWS normalization', () => {
  it('normalizes a zone-only alert', () => {
    const a = normalizeNwsAlert(feature())!;
    expect(a.messageId).toBe('urn:oid:A.1');
    expect(a.hazardType).toBe('tornado');
    expect(a.severity).toBe('severe');
    expect(a.geometry).toBeNull();
    expect(a.zoneCodes).toEqual(['TXC201']);
    expect(a.zoneUrls.TXC201).toBe('https://api.weather.gov/zones/county/TXC201');
    expect(a.startsAt).toBe('2026-11-10T13:00:00-06:00'); // onset preferred over effective
    expect(a.endsAt).toBe('2026-11-10T20:00:00-06:00'); // ends preferred over expires
    expect(a.messageType).toBe('alert');
  });

  it('orders references most recent first', () => {
    const a = normalizeNwsAlert(
      feature({
        messageType: 'Update',
        references: [
          { identifier: 'old', sent: '2026-11-10T08:00:00Z' },
          { identifier: 'newer', sent: '2026-11-10T10:00:00Z' },
        ],
      }),
    )!;
    expect(a.references).toEqual(['newer', 'old']);
    expect(a.messageType).toBe('update');
  });

  it('drops test, exercise and draft messages', () => {
    expect(normalizeNwsAlert(feature({ status: 'Test' }))).toBeNull();
    expect(normalizeNwsAlert(feature({ status: 'Exercise' }))).toBeNull();
    expect(normalizeNwsAlert(feature({ status: 'Draft' }))).toBeNull();
  });

  it('classifies event names into hazard types', () => {
    expect(classifyNwsEvent('Severe Thunderstorm Warning')).toBe('severe_thunderstorm');
    expect(classifyNwsEvent('Flash Flood Warning')).toBe('flash_flood');
    expect(classifyNwsEvent('Flood Advisory')).toBe('flood');
    expect(classifyNwsEvent('Coastal Flood Advisory')).toBe('coastal');
    expect(classifyNwsEvent('Hurricane Warning')).toBe('hurricane');
    expect(classifyNwsEvent('Winter Storm Warning')).toBe('winter');
    expect(classifyNwsEvent('Red Flag Warning')).toBe('fire');
    expect(classifyNwsEvent('High Wind Warning')).toBe('wind');
    expect(classifyNwsEvent('Excessive Heat Warning')).toBe('heat');
    expect(classifyNwsEvent('Freeze Warning')).toBe('cold');
    expect(classifyNwsEvent('Small Craft Advisory')).toBe('marine');
    expect(classifyNwsEvent('Gale Warning')).toBe('marine');
    expect(classifyNwsEvent('Hurricane Force Wind Warning')).toBe('marine');
    expect(classifyNwsEvent('Something New')).toBe('other');
  });

  it('treats alerts that only cover marine zones as marine', () => {
    expect(classifyNwsEvent('Dense Fog Advisory', ['GMZ270', 'PZZ535'])).toBe('marine');
    expect(classifyNwsEvent('Dense Fog Advisory', ['GMZ270', 'TXZ211'])).toBe('fog');
  });
});

// ------------------------------------------------------------ deduplication
describe('deduplication', () => {
  const none = new Map<string, string>();

  it('creates an event for a first-seen alert', () => {
    expect(decideIngest({ messageId: 'm1', references: [], messageType: 'alert' }, none)).toEqual({
      action: 'create',
      status: 'active',
    });
  });

  it('skips a message that is already stored', () => {
    const known = new Map([['m1', 'event-1']]);
    expect(decideIngest({ messageId: 'm1', references: [], messageType: 'alert' }, known)).toEqual({
      action: 'skip',
      eventId: 'event-1',
    });
  });

  it('applies an update to the event its reference belongs to', () => {
    const known = new Map([['m1', 'event-1']]);
    expect(decideIngest({ messageId: 'm2', references: ['m1'], messageType: 'update' }, known)).toEqual({
      action: 'update',
      eventId: 'event-1',
    });
  });

  it('follows a long chain: m3 references m2 and m1', () => {
    const known = new Map([
      ['m1', 'event-1'],
      ['m2', 'event-1'],
    ]);
    expect(decideIngest({ messageId: 'm3', references: ['m2', 'm1'], messageType: 'update' }, known)).toEqual({
      action: 'update',
      eventId: 'event-1',
    });
  });

  it('still links when only an older reference is known (a message was missed)', () => {
    const known = new Map([['m1', 'event-1']]);
    expect(decideIngest({ messageId: 'm3', references: ['m2', 'm1'], messageType: 'update' }, known)).toEqual({
      action: 'update',
      eventId: 'event-1',
    });
  });

  it('prefers the most recent known reference when references span two events', () => {
    const known = new Map([
      ['old', 'event-old'],
      ['new', 'event-new'],
    ]);
    expect(decideIngest({ messageId: 'm9', references: ['new', 'old'], messageType: 'update' }, known)).toEqual({
      action: 'update',
      eventId: 'event-new',
    });
  });

  it('cancels a known event', () => {
    const known = new Map([['m1', 'event-1']]);
    expect(decideIngest({ messageId: 'm2', references: ['m1'], messageType: 'cancel' }, known)).toEqual({
      action: 'cancel',
      eventId: 'event-1',
    });
  });

  it('stores a cancellation of an unseen event as cancelled, never active', () => {
    expect(decideIngest({ messageId: 'm2', references: ['m1'], messageType: 'cancel' }, none)).toEqual({
      action: 'create',
      status: 'cancelled',
    });
  });

  it('treats an update whose references are all unknown as a new event', () => {
    expect(decideIngest({ messageId: 'm2', references: ['m1'], messageType: 'update' }, none)).toEqual({
      action: 'create',
      status: 'active',
    });
  });
});

// ------------------------------------------------------------ rule evaluation
const ORG = 'org-1';
const rule = (o: Partial<RuleInput> = {}): RuleInput => ({
  id: 'rule-1',
  organizationId: ORG,
  enabled: true,
  hazardTypes: [],
  minSeverity: 'moderate',
  scope: 'all',
  clientIds: [],
  propertyIds: [],
  recipientMode: 'linked',
  contactIds: [],
  channels: ['email'],
  ...o,
});
const contact = (o: Partial<ContactInput> = {}): ContactInput => ({
  id: 'contact-1',
  organizationId: ORG,
  clientId: 'client-A',
  propertyIds: [],
  email: 'a@example.test',
  mobile: null,
  smsOptIn: false,
  ...o,
});
const impact = (propertyId: string, clientId = 'client-A', organizationId = ORG): ImpactInput => ({
  propertyId,
  clientId,
  organizationId,
});
const plan = (o: {
  severity?: Severity;
  hazardType?: string;
  impacts?: ImpactInput[];
  rules?: RuleInput[];
  contacts?: ContactInput[];
  already?: Array<[string, Severity]>;
  enabledChannels?: Array<'email' | 'sms'>;
}) =>
  planNotifications({
    event: { hazardType: o.hazardType ?? 'tornado', severity: o.severity ?? 'severe' },
    impacts: o.impacts ?? [impact('p1')],
    rules: o.rules ?? [rule()],
    contacts: o.contacts ?? [contact()],
    alreadyNotified: new Map(o.already ?? []),
    enabledChannels: o.enabledChannels,
  });

describe('rule evaluation', () => {
  it('notifies a linked contact when the event meets the threshold', () => {
    const out = plan({});
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ contactId: 'contact-1', channel: 'email', propertyIds: ['p1'], severity: 'severe', isEscalation: false });
  });

  it('does nothing below the minimum severity, and fires exactly at it', () => {
    expect(plan({ severity: 'minor' })).toHaveLength(0);
    expect(plan({ severity: 'moderate' })).toHaveLength(1);
  });

  it('never notifies for unknown severity, even with the lowest threshold', () => {
    expect(plan({ severity: 'unknown', rules: [rule({ minSeverity: 'minor' })] })).toHaveLength(0);
  });

  it('filters by hazard type; an empty list means all types', () => {
    expect(plan({ hazardType: 'flood', rules: [rule({ hazardTypes: ['tornado'] })] })).toHaveLength(0);
    expect(plan({ hazardType: 'tornado', rules: [rule({ hazardTypes: ['tornado', 'flood'] })] })).toHaveLength(1);
    expect(plan({ hazardType: 'anything', rules: [rule({ hazardTypes: [] })] })).toHaveLength(1);
  });

  it('ignores disabled rules', () => {
    expect(plan({ rules: [rule({ enabled: false })] })).toHaveLength(0);
  });

  it('groups all of a contact\'s affected properties into one message', () => {
    const out = plan({ impacts: [impact('p1'), impact('p2'), impact('p3')] });
    expect(out).toHaveLength(1);
    expect(out[0]!.propertyIds).toEqual(['p1', 'p2', 'p3']);
  });

  it('sends one message per contact even when several rules match', () => {
    const out = plan({ rules: [rule({ id: 'r1' }), rule({ id: 'r2', minSeverity: 'minor' })] });
    expect(out).toHaveLength(1);
    expect(out[0]!.ruleId).toBe('r1');
    expect(out[0]!.propertyIds).toEqual(['p1']);
  });

  it('only tells a client contact about that client\'s properties', () => {
    const out = plan({
      impacts: [impact('p1', 'client-A'), impact('p2', 'client-B')],
      contacts: [contact({ id: 'cA', clientId: 'client-A' }), contact({ id: 'cB', clientId: 'client-B' })],
    });
    expect(out.find((n) => n.contactId === 'cA')!.propertyIds).toEqual(['p1']);
    expect(out.find((n) => n.contactId === 'cB')!.propertyIds).toEqual(['p2']);
  });

  it('limits a property-linked contact to their specific properties', () => {
    const out = plan({
      impacts: [impact('p1'), impact('p2')],
      contacts: [contact({ propertyIds: ['p2'] })],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.propertyIds).toEqual(['p2']);
  });

  it('respects client and property scope', () => {
    const impacts = [impact('p1', 'client-A'), impact('p2', 'client-B')];
    const contacts = [contact({ id: 'cA', clientId: 'client-A' }), contact({ id: 'cB', clientId: 'client-B' })];
    const byClient = plan({ impacts, contacts, rules: [rule({ scope: 'clients', clientIds: ['client-B'] })] });
    expect(byClient.map((n) => n.contactId)).toEqual(['cB']);
    const byProperty = plan({ impacts, contacts, rules: [rule({ scope: 'properties', propertyIds: ['p1'] })] });
    expect(byProperty.map((n) => n.contactId)).toEqual(['cA']);
  });

  it('sends specific recipients every covered property regardless of client link', () => {
    const out = plan({
      impacts: [impact('p1', 'client-A'), impact('p2', 'client-B')],
      contacts: [contact({ id: 'ops', clientId: null })],
      rules: [rule({ recipientMode: 'specific', contactIds: ['ops'] })],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.propertyIds).toEqual(['p1', 'p2']);
  });

  it('never crosses organizations', () => {
    const out = plan({
      impacts: [impact('p1', 'client-A', 'org-2')],
      rules: [rule({ recipientMode: 'specific', contactIds: ['contact-1'] })],
    });
    expect(out).toHaveLength(0);
  });

  it('does not repeat a notification at the same or lower severity', () => {
    const already: Array<[string, Severity]> = [[notifiedKey('contact-1', 'p1', 'email'), 'severe']];
    expect(plan({ severity: 'severe', already })).toHaveLength(0);
    expect(plan({ severity: 'moderate', already })).toHaveLength(0);
  });

  it('sends a follow-up when severity escalates, flagged as an escalation', () => {
    const already: Array<[string, Severity]> = [[notifiedKey('contact-1', 'p1', 'email'), 'severe']];
    const out = plan({ severity: 'extreme', already });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: 'extreme', isEscalation: true, propertyIds: ['p1'] });
  });

  it('includes only newly affected properties when the area grows', () => {
    const already: Array<[string, Severity]> = [[notifiedKey('contact-1', 'p1', 'email'), 'severe']];
    const out = plan({ impacts: [impact('p1'), impact('p2')], already });
    expect(out).toHaveLength(1);
    expect(out[0]!.propertyIds).toEqual(['p2']);
    expect(out[0]!.isEscalation).toBe(false);
  });

  it('skips contacts without an email address', () => {
    expect(plan({ contacts: [contact({ email: null })] })).toHaveLength(0);
  });

  it('keeps SMS off unless the channel is enabled, the rule asks for it, and the contact opted in', () => {
    const smsRule = rule({ channels: ['email', 'sms'] });
    const optedIn = contact({ mobile: '+15555550100', smsOptIn: true });
    const notOptedIn = contact({ mobile: '+15555550100', smsOptIn: false });
    // Phase 1 default: email only.
    expect(plan({ rules: [smsRule], contacts: [optedIn] }).map((n) => n.channel)).toEqual(['email']);
    const enabled: Array<'email' | 'sms'> = ['email', 'sms'];
    expect(plan({ rules: [smsRule], contacts: [optedIn], enabledChannels: enabled }).map((n) => n.channel).sort()).toEqual(['email', 'sms']);
    expect(plan({ rules: [smsRule], contacts: [notOptedIn], enabledChannels: enabled }).map((n) => n.channel)).toEqual(['email']);
    expect(plan({ rules: [rule()], contacts: [optedIn], enabledChannels: enabled }).map((n) => n.channel)).toEqual(['email']);
  });
});

// ------------------------------------------------------------ message + geocoder parsing
describe('message rendering', () => {
  const msg = renderHazardEmail({
    eventName: 'Tornado Warning',
    severity: 'extreme',
    headline: 'Tornado Warning until 5 PM',
    instruction: 'Take cover <now>',
    areaDesc: 'Harris, TX',
    sourceName: 'National Weather Service',
    sourceUrl: 'https://api.weather.gov/alerts/x',
    endsAt: '2026-11-10T23:00:00Z',
    isEscalation: true,
    contactName: 'Pat',
    properties: [
      { name: 'Warehouse 1', address: '1 Main St, Houston, TX', clientName: 'Acme' },
      { name: 'Office <A>', address: null, clientName: 'Acme' },
    ],
    mapUrl: 'https://app.example.test/?event=abc',
  });

  it('states hazard, severity, properties, source, map link and disclaimer', () => {
    for (const body of [msg.text, msg.html]) {
      expect(body).toContain('Tornado Warning');
      expect(body).toContain('Extreme');
      expect(body).toContain('Warehouse 1');
      expect(body).toContain('National Weather Service');
      expect(body).toContain('https://app.example.test/?event=abc');
      expect(body).toContain(DISCLAIMER);
    }
    expect(msg.subject).toBe('UPGRADED: Tornado Warning (Extreme) - 2 properties affected');
  });

  it('escapes HTML in user and source text', () => {
    expect(msg.html).toContain('Office &lt;A&gt;');
    expect(msg.html).toContain('Take cover &lt;now&gt;');
    expect(msg.html).not.toContain('<now>');
  });
});

describe('Census batch format', () => {
  it('builds quoted CSV rows', () => {
    expect(buildBatchCsv([{ id: '1', street: '1 "Big" St, Suite 2', city: 'Austin', state: 'TX', zip: '78701' }])).toBe(
      '"1","1 ""Big"" St, Suite 2","Austin","TX","78701"',
    );
  });

  it('parses matches, non-matches and ties', () => {
    const text = [
      '"1","1600 Pennsylvania Ave NW, Washington, DC, 20500","Match","Exact","1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500","-77.035189204737,38.898702605246","76225813","L"',
      '"3","999999 Nowhere Blvd, Faketown, TX, 00000","No_Match"',
      '"4","5 Elm St, Springfield, , ","Tie"',
    ].join('\n');
    const out = parseBatchResponse(text);
    expect(out[0]).toMatchObject({ id: '1', matched: true, lon: -77.035189204737, lat: 38.898702605246, detail: 'Exact' });
    expect(out[0]!.matchedAddress).toBe('1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500');
    expect(out[1]).toMatchObject({ id: '3', matched: false, lon: null, lat: null, detail: 'No_Match' });
    expect(out[2]).toMatchObject({ id: '4', matched: false, detail: 'Tie' });
  });
});
