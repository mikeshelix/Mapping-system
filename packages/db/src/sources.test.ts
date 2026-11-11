// Integration tests for non-NWS sources and SMS, against a real PostGIS database.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SourceEvent } from '@hazard/core';
import { createClient, type Sql } from './client';
import { evaluatePendingEvents, matchEvent, upsertZone } from './engine';
import { migrate } from './migrate';
import { expireEnded, expireMissingKeys, upsertSourceEvent } from './sources';

const TEST_URL = (process.env.TEST_DATABASE_URL ?? 'postgres://hazard:hazard_dev@localhost:5433/hazard_test').replace(/hazard_test$/, 'hazard_test2');
const OPTS = { appBaseUrl: 'https://app.example.test' };
let sql: Sql;

beforeAll(async () => {
  const url = new URL(TEST_URL);
  const dbName = url.pathname.slice(1);
  if (!/_test\d*$/.test(dbName)) throw new Error('Refusing to reset a database that is not a test database');
  const adminUrl = new URL(TEST_URL);
  adminUrl.pathname = '/postgres';
  const admin = createClient(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.end();
  sql = createClient(TEST_URL, { max: 4 });
  await migrate(sql);
});
afterAll(async () => {
  await sql?.end();
});

let orgId: string;
let clientId: string;
let contactId: string;

async function addProperty(name: string, lon: number, lat: number): Promise<string> {
  const [row] = await sql`
    INSERT INTO properties (organization_id, client_id, name, location)
    VALUES (${orgId}, ${clientId}, ${name}, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)) RETURNING id`;
  return row!.id;
}
const eventRow = async (source: string, like: string) =>
  (await sql`SELECT id, source_event_id, status, severity FROM hazard_events WHERE source = ${source} AND source_event_id LIKE ${like} ORDER BY first_seen_at`).map((r) => ({ ...r }));
const impactNames = async (eventId: string) =>
  (await sql`SELECT p.name FROM property_impacts i JOIN properties p ON p.id = i.property_id WHERE i.hazard_event_id = ${eventId} ORDER BY p.name`).map((r) => r.name);
const sent = async () =>
  (await sql`SELECT channel, status, severity, is_escalation, recipient, body_text, error FROM notifications ORDER BY created_at, channel`).map((r) => ({ ...r }));

function pointEvent(o: Partial<SourceEvent> = {}): SourceEvent {
  return {
    source: 'spc',
    key: 'hail:2026-05-10:1955:39.13:-100.91',
    hazardType: 'hail',
    eventName: 'Hail report: 1.75 in',
    severity: 'severe',
    nativeSeverity: '175',
    headline: 'Hail report',
    areaDesc: 'Oakley, KS',
    point: { lon: -100.91, lat: 39.13 },
    startsAt: '2026-05-10T19:55:00Z',
    endsAt: '2099-01-01T00:00:00Z',
    sourceUrl: null,
    details: {},
    raw: {},
    ...o,
  };
}
const square = (w: number, s: number, size: number) => ({
  type: 'Polygon',
  coordinates: [[[w, s], [w + size, s], [w + size, s + size], [w, s + size], [w, s]]],
});

beforeEach(async () => {
  await sql`TRUNCATE organizations, hazard_event_versions, hazard_events, geo_zones, notifications, sms_events CASCADE`;
  const [org] = await sql`INSERT INTO organizations (name, slug) VALUES ('Org', 'org') RETURNING id`;
  orgId = org!.id;
  const [client] = await sql`INSERT INTO clients (organization_id, name) VALUES (${orgId}, 'Acme') RETURNING id`;
  clientId = client!.id;
  const [contact] = await sql`
    INSERT INTO contacts (organization_id, client_id, name, email, mobile, sms_opt_in, sms_opt_in_at)
    VALUES (${orgId}, ${clientId}, 'Pat', 'pat@example.test', '+15555550100', true, now()) RETURNING id`;
  contactId = contact!.id;
  await sql`INSERT INTO alert_rules (organization_id, name, min_severity, channels) VALUES (${orgId}, 'Default', 'moderate', '{email,sms}')`;
});

describe('point events with a distance buffer', () => {
  it('matches properties within the configured distance and not beyond it', async () => {
    // 0.05 degrees of longitude at 39N is about 4.3 km; 0.12 degrees is about 10.4 km.
    await addProperty('Near (4 km)', -100.86, 39.13);
    await addProperty('Far (10 km)', -100.79, 39.13);
    await upsertSourceEvent(sql, pointEvent(), { bufferMeters: 8000 });
    const [event] = await eventRow('spc', 'hail:%');
    await matchEvent(sql, event!.id);
    expect(await impactNames(event!.id)).toEqual(['Near (4 km)']);
  });

  it('honours a different buffer setting', async () => {
    await addProperty('Far (10 km)', -100.79, 39.13);
    await upsertSourceEvent(sql, pointEvent(), { bufferMeters: 12_000 });
    const [event] = await eventRow('spc', 'hail:%');
    await matchEvent(sql, event!.id);
    expect(await impactNames(event!.id)).toEqual(['Far (10 km)']);
  });

  it('uses the event radius for earthquakes, ignoring the feed buffer', async () => {
    await addProperty('80 km away', -117.33, 34.1);
    const quake = pointEvent({ source: 'usgs', key: 'us1', hazardType: 'earthquake', point: { lon: -118.2, lat: 34.1 }, radiusMeters: 100_000 });
    await upsertSourceEvent(sql, quake, { bufferMeters: 10 });
    const [event] = await eventRow('usgs', 'us1');
    await matchEvent(sql, event!.id);
    expect(await impactNames(event!.id)).toEqual(['80 km away']);
  });
});

describe('deduplication for keyed sources', () => {
  it('creates once, skips an unchanged repeat, and updates on change', async () => {
    expect(await upsertSourceEvent(sql, pointEvent(), { bufferMeters: 8000 })).toBe('create');
    expect(await upsertSourceEvent(sql, pointEvent(), { bufferMeters: 8000 })).toBe('skip');
    expect(await upsertSourceEvent(sql, pointEvent({ severity: 'extreme', eventName: 'Hail report: 3.00 in' }), { bufferMeters: 8000 })).toBe('update');
    const events = await eventRow('spc', 'hail:%');
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('extreme');
    const [versions] = await sql`SELECT count(*)::int AS n FROM hazard_event_versions`;
    expect(versions!.n).toBe(2);
  });

  it('expires listed-source events that are no longer listed, and time-limited events once ended', async () => {
    const fire = (key: string): SourceEvent => pointEvent({ source: 'wfigs', key, hazardType: 'wildfire', point: undefined, geometry: square(-120, 38, 0.1), endsAt: null });
    await upsertSourceEvent(sql, fire('A'));
    await upsertSourceEvent(sql, fire('B'));
    expect(await expireMissingKeys(sql, 'wfigs', ['B'])).toBe(1);
    expect((await eventRow('wfigs', 'A'))[0]!.status).toBe('expired');
    expect((await eventRow('wfigs', 'B'))[0]!.status).toBe('active');

    await upsertSourceEvent(sql, pointEvent({ endsAt: '2020-01-01T00:00:00Z' }), { bufferMeters: 8000 });
    expect(await expireEnded(sql)).toBe(1);
    expect((await eventRow('spc', 'hail:%'))[0]!.status).toBe('expired');
  });

  it('treats a new flood at the same gauge as a new event after the first one ended', async () => {
    const gauge = pointEvent({ source: 'nwps', key: 'AMRL1', episodic: true, hazardType: 'flood', endsAt: null });
    expect(await upsertSourceEvent(sql, gauge)).toBe('create');
    expect(await upsertSourceEvent(sql, gauge)).toBe('skip');
    expect(await upsertSourceEvent(sql, { ...gauge, severity: 'extreme' })).toBe('update');
    await expireMissingKeys(sql, 'nwps', []);
    await sql`UPDATE hazard_events SET source_event_id = 'AMRL1@2026-01-01T00:00' WHERE source = 'nwps'`;
    expect(await upsertSourceEvent(sql, gauge)).toBe('create');
    expect((await eventRow('nwps', 'AMRL1@%')).map((e) => e.status)).toEqual(['expired', 'active']);
  });
});

describe('polygon handling', () => {
  it('cuts stronger wind bands out of weaker ones so a property lands in exactly one', async () => {
    await addProperty('Core', -79.5, 25.5);
    await addProperty('Outer', -78.2, 25.5);
    const inner = square(-80, 25, 1);
    const outer = square(-80, 25, 2);
    await upsertSourceEvent(sql, pointEvent({ source: 'nhc', key: 's:wind64', hazardType: 'hurricane', severity: 'extreme', point: undefined, geometry: inner, endsAt: null }));
    await upsertSourceEvent(sql, pointEvent({ source: 'nhc', key: 's:wind34', hazardType: 'hurricane', severity: 'moderate', point: undefined, geometry: outer, subtract: [inner], endsAt: null }));
    const [strong] = await eventRow('nhc', 's:wind64');
    const [weak] = await eventRow('nhc', 's:wind34');
    await matchEvent(sql, strong!.id);
    await matchEvent(sql, weak!.id);
    expect(await impactNames(strong!.id)).toEqual(['Core']);
    expect(await impactNames(weak!.id)).toEqual(['Outer']);
  });

  it('buffers a wildfire perimeter by the configured distance', async () => {
    await addProperty('Inside', -119.95, 38.05);
    await addProperty('2 km outside', -119.877, 38.05);
    await addProperty('6 km outside', -119.83, 38.05);
    const fire = pointEvent({ source: 'wfigs', key: 'F1', hazardType: 'wildfire', point: undefined, geometry: square(-120, 38, 0.1), endsAt: null });
    await upsertSourceEvent(sql, fire, { bufferMeters: 3200 });
    const [event] = await eventRow('wfigs', 'F1');
    await matchEvent(sql, event!.id);
    expect(await impactNames(event!.id)).toEqual(['2 km outside', 'Inside']);
  });

  it('accumulates a hail swath across polls', async () => {
    await addProperty('First cell', -96.995, 35.995);
    await addProperty('Second cell', -96.895, 35.995);
    const cell = (w: number): SourceEvent =>
      pointEvent({ source: 'mesh', key: '2026-05-10:35:-97:moderate', point: undefined, geometry: { type: 'MultiPolygon', coordinates: [square(w, 35.99, 0.01).coordinates] }, mergeGeometry: true });
    expect(await upsertSourceEvent(sql, cell(-97))).toBe('create');
    expect(await upsertSourceEvent(sql, cell(-96.9))).toBe('update');
    const [event] = await eventRow('mesh', '%');
    await matchEvent(sql, event!.id);
    expect(await impactNames(event!.id)).toEqual(['First cell', 'Second cell']);
  });

  it('matches FEMA declarations through county shapes', async () => {
    await addProperty('In county', -85.5, 30.2);
    const fema = pointEvent({ source: 'fema', key: 'DR-4955-FL', hazardType: 'disaster_declaration', point: undefined, zoneCodes: ['FLC005'] });
    await upsertSourceEvent(sql, fema);
    const [event] = await eventRow('fema', 'DR-%');
    expect((await sql`SELECT zones_pending FROM hazard_events WHERE id = ${event!.id}`)[0]!.zones_pending).toBe(true);
    await upsertZone(sql, { code: 'FLC005', kind: 'county', name: 'Bay', state: 'FL', geometry: square(-86, 30, 1) });
    await matchEvent(sql, event!.id);
    expect(await impactNames(event!.id)).toEqual(['In county']);
  });
});

describe('text messages', () => {
  const both = { ...OPTS, enabledChannels: ['email', 'sms'] as Array<'email' | 'sms'> };

  it('sends email only while the SMS channel is switched off', async () => {
    await addProperty('Site', -100.9, 39.13);
    await upsertSourceEvent(sql, pointEvent(), { bufferMeters: 8000 });
    await evaluatePendingEvents(sql, OPTS);
    expect((await sent()).map((n) => n.channel)).toEqual(['email']);
  });

  it('sends a text to an opted-in contact when the rule asks for it', async () => {
    await addProperty('Site', -100.9, 39.13);
    await upsertSourceEvent(sql, pointEvent(), { bufferMeters: 8000 });
    await evaluatePendingEvents(sql, both);
    const messages = await sent();
    expect(messages.map((n) => [n.channel, n.status])).toEqual([
      ['email', 'queued'],
      ['sms', 'queued'],
    ]);
    const text = messages[1]!;
    expect(text.recipient).toBe('+15555550100');
    expect(text.body_text).toContain('Hail report: 1.75 in (Severe)');
    expect(text.body_text).toContain('NOAA Storm Prediction Center');
    expect(text.body_text).toContain('Reply STOP to opt out.');
  });

  it('never texts a contact without opt-in, or one who has opted out', async () => {
    await addProperty('Site', -100.9, 39.13);
    await sql`UPDATE contacts SET sms_opt_in = false WHERE id = ${contactId}`;
    await upsertSourceEvent(sql, pointEvent(), { bufferMeters: 8000 });
    await evaluatePendingEvents(sql, both);
    expect((await sent()).map((n) => n.channel)).toEqual(['email']);

    await sql`TRUNCATE notifications CASCADE`;
    await sql`UPDATE contacts SET sms_opt_in = true, sms_opt_out_at = now() WHERE id = ${contactId}`;
    await upsertSourceEvent(sql, pointEvent({ key: 'hail:second' }), { bufferMeters: 8000 });
    await evaluatePendingEvents(sql, both);
    expect((await sent()).map((n) => n.channel)).toEqual(['email']);
  });

  it('enforces the per-event cap and records what was held back', async () => {
    await addProperty('Site', -100.9, 39.13);
    await sql`UPDATE organizations SET settings = '{"smsPerEventCap": 1, "smsPerDayCap": 100}' WHERE id = ${orgId}`;
    await sql`
      INSERT INTO contacts (organization_id, client_id, name, mobile, sms_opt_in, sms_opt_in_at)
      VALUES (${orgId}, ${clientId}, 'Sam', '+15555550101', true, now())`;
    await upsertSourceEvent(sql, pointEvent(), { bufferMeters: 8000 });
    const result = await evaluatePendingEvents(sql, both);
    const texts = (await sent()).filter((n) => n.channel === 'sms');
    expect(texts.map((n) => n.status).sort()).toEqual(['queued', 'skipped']);
    expect(texts.find((n) => n.status === 'skipped')!.error).toMatch(/per-event/);
    expect(result.notificationsQueued).toBe(2); // one email + one text; the capped text is not counted
    // Re-evaluating does not retry or duplicate the held-back text.
    await sql`UPDATE hazard_events SET needs_evaluation = true`;
    await evaluatePendingEvents(sql, both);
    expect((await sent()).filter((n) => n.channel === 'sms')).toHaveLength(2);
  });

  it('enforces the daily cap across events', async () => {
    await addProperty('Site', -100.9, 39.13);
    await sql`UPDATE organizations SET settings = '{"smsPerEventCap": 10, "smsPerDayCap": 1}' WHERE id = ${orgId}`;
    await upsertSourceEvent(sql, pointEvent({ key: 'hail:one' }), { bufferMeters: 8000 });
    await evaluatePendingEvents(sql, both);
    await upsertSourceEvent(sql, pointEvent({ key: 'hail:two' }), { bufferMeters: 8000 });
    await evaluatePendingEvents(sql, both);
    const texts = (await sent()).filter((n) => n.channel === 'sms');
    expect(texts.map((n) => n.status)).toEqual(['queued', 'skipped']);
    expect(texts[1]!.error).toMatch(/daily/);
  });
});
