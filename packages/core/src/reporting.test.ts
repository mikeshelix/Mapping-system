import { describe, expect, it } from 'vitest';
import {
  csvCell,
  DEFAULT_EXPOSURE_FACTORS,
  estimateExposure,
  HAZARD_TYPES,
  planNotifications,
  readExposureFactors,
  replayRule,
  RULE_TEMPLATES,
  toCsv,
  type ContactInput,
  type ReplayEvent,
  type RuleInput,
} from './index';

const ORG = 'org-1';
const rule = (o: Partial<RuleInput> = {}): RuleInput => ({
  id: 'r1', organizationId: ORG, enabled: true, hazardTypes: [], minSeverity: 'moderate', scope: 'all',
  clientIds: [], propertyIds: [], zipCodes: [], recipientMode: 'linked', contactIds: [], channels: ['email'], ...o,
});
const contact = (o: Partial<ContactInput> = {}): ContactInput => ({
  id: 'c1', organizationId: ORG, clientId: 'client-A', propertyIds: [], email: 'a@example.test', mobile: null, smsOptIn: false, ...o,
});
const impact = (propertyId: string, zip: string | null = null, clientId = 'client-A') => ({ propertyId, clientId, organizationId: ORG, zip });
const event = (o: Partial<ReplayEvent> = {}): ReplayEvent => ({
  id: 'e1', hazardType: 'hail', eventName: 'Hail', firstSeenAt: '2026-10-01T00:00:00Z', severities: ['severe'], impacts: [impact('p1')], ...o,
});

describe('ZIP-code rules', () => {
  const plan = (zipCodes: string[], zip: string | null) =>
    planNotifications({
      event: { hazardType: 'hail', severity: 'severe' },
      impacts: [impact('p1', zip)],
      rules: [rule({ scope: 'zips', zipCodes })],
      contacts: [contact()],
      alreadyNotified: new Map(),
    });

  it('covers properties in the listed ZIP codes only', () => {
    expect(plan(['98584'], '98584')).toHaveLength(1);
    expect(plan(['98584'], '20500')).toHaveLength(0);
    expect(plan(['98584', '20500'], '20500')).toHaveLength(1);
  });

  it('matches ZIP+4 and ignores properties with no ZIP', () => {
    expect(plan(['98584'], '98584-1234')).toHaveLength(1);
    expect(plan(['98584'], null)).toHaveLength(0);
  });
});

describe('rule templates', () => {
  it('only use real hazard types and notifiable severities', () => {
    for (const t of RULE_TEMPLATES) {
      for (const type of t.hazardTypes) expect(HAZARD_TYPES).toContain(type);
      expect(['minor', 'moderate', 'severe', 'extreme']).toContain(t.minSeverity);
    }
    expect(new Set(RULE_TEMPLATES.map((t) => t.id)).size).toBe(RULE_TEMPLATES.length);
  });
});

describe('rule preview (replay)', () => {
  it('counts events, properties, contacts and messages', () => {
    const preview = replayRule(rule(), [contact()], [
      event({ id: 'e1', impacts: [impact('p1'), impact('p2')] }),
      event({ id: 'e2', hazardType: 'flood', impacts: [impact('p2'), impact('p3')] }),
      event({ id: 'e3', severities: ['minor'] }), // below the threshold
    ]);
    expect(preview).toMatchObject({
      eventsConsidered: 3,
      eventsMatched: 2,
      propertiesAffected: 3,
      contactsNotified: 1,
      messages: { email: 2, sms: 0 }, // one grouped message per event, not per property
      followUps: 0,
    });
    expect(preview.byHazard).toEqual([
      { hazardType: 'hail', events: 1, messages: 1 },
      { hazardType: 'flood', events: 1, messages: 1 },
    ]);
  });

  it('counts a follow-up only when a later version is more severe', () => {
    const preview = replayRule(rule(), [contact()], [
      event({ severities: ['moderate', 'moderate', 'severe', 'moderate', 'extreme'] }),
    ]);
    expect(preview.messages.email).toBe(3); // moderate, then severe, then extreme
    expect(preview.followUps).toBe(2);
    expect(preview.eventsMatched).toBe(1);
    expect(preview.busiest[0]).toMatchObject({ severity: 'extreme', messages: 3, properties: 1 });
  });

  it('starts notifying at the version that first reaches the threshold', () => {
    const preview = replayRule(rule({ minSeverity: 'severe' }), [contact()], [event({ severities: ['minor', 'moderate', 'severe'] })]);
    expect(preview.messages.email).toBe(1);
    expect(preview.followUps).toBe(0);
  });

  it('never counts unknown-severity events', () => {
    expect(replayRule(rule({ minSeverity: 'minor' }), [contact()], [event({ severities: ['unknown'] })]).eventsMatched).toBe(0);
  });

  it('respects hazard filters, scope and channels', () => {
    const events = [event({ id: 'e1', hazardType: 'hail', impacts: [impact('p1', '98584')] }), event({ id: 'e2', hazardType: 'flood', impacts: [impact('p2', '20500')] })];
    expect(replayRule(rule({ hazardTypes: ['flood'] }), [contact()], events).eventsMatched).toBe(1);
    expect(replayRule(rule({ scope: 'zips', zipCodes: ['98584'] }), [contact()], events).propertiesAffected).toBe(1);
    const texted = replayRule(rule({ channels: ['email', 'sms'] }), [contact({ mobile: '+15555550100', smsOptIn: true })], events);
    expect(texted.messages).toEqual({ email: 2, sms: 2 });
    const notOptedIn = replayRule(rule({ channels: ['email', 'sms'] }), [contact({ mobile: '+15555550100', smsOptIn: false })], events);
    expect(notOptedIn.messages).toEqual({ email: 2, sms: 0 });
  });

  it('previews a disabled rule as if it were on', () => {
    expect(replayRule(rule({ enabled: false }), [contact()], [event()]).eventsMatched).toBe(1);
  });

  it('reports nothing when no contact would receive it', () => {
    expect(replayRule(rule(), [], [event()])).toMatchObject({ eventsMatched: 0, propertiesAffected: 0, messages: { email: 0, sms: 0 } });
  });
});

describe('exposure estimate', () => {
  it('is declared value times the factor for the severity', () => {
    expect(estimateExposure(1_000_000, 'minor', DEFAULT_EXPOSURE_FACTORS)).toBe(10_000);
    expect(estimateExposure(1_000_000, 'moderate', DEFAULT_EXPOSURE_FACTORS)).toBe(50_000);
    expect(estimateExposure(1_000_000, 'severe', DEFAULT_EXPOSURE_FACTORS)).toBe(150_000);
    expect(estimateExposure('1250000.00', 'extreme', DEFAULT_EXPOSURE_FACTORS)).toBe(500_000);
  });

  it('is zero for unknown severity and blank when there is no declared value', () => {
    expect(estimateExposure(1_000_000, 'unknown', DEFAULT_EXPOSURE_FACTORS)).toBe(0);
    expect(estimateExposure(null, 'severe', DEFAULT_EXPOSURE_FACTORS)).toBeNull();
    expect(estimateExposure('', 'severe', DEFAULT_EXPOSURE_FACTORS)).toBeNull();
    expect(estimateExposure('abc', 'severe', DEFAULT_EXPOSURE_FACTORS)).toBeNull();
  });

  it('reads admin-set factors and falls back to defaults for bad values', () => {
    expect(readExposureFactors({ exposureFactors: { severe: 0.25, extreme: 7, minor: 'x' } })).toEqual({
      minor: 0.01,
      moderate: 0.05,
      severe: 0.25,
      extreme: 0.4,
    });
    expect(readExposureFactors(null)).toEqual(DEFAULT_EXPOSURE_FACTORS);
  });
});

describe('CSV output', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a, b')).toBe('"a, b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(-100.91)).toBe('-100.91');
  });

  it('neutralizes text a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('-5 Main St')).toBe("'-5 Main St");
  });

  it('builds a file with a header row', () => {
    expect(toCsv(['a', 'b'], [[1, 'x'], [2, 'y, z']])).toBe('a,b\r\n1,x\r\n2,"y, z"\r\n');
  });
});
