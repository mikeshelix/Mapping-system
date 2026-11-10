// Integration tests against a real PostGIS database (TEST_DATABASE_URL).
// Start it with `pnpm db:up`. The test database is created and reset automatically.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizeNwsAlert, type NormalizedAlert, type NwsAlertFeature } from '@hazard/core';
import { createClient, type Sql } from './client';
import {
  evaluatePendingEvents,
  expireMissing,
  ingestAlert,
  matchEvent,
  missingZoneCodes,
  queueNotificationsForEvent,
  upsertZone,
} from './engine';
import { migrate } from './migrate';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://hazard:hazard_dev@localhost:5433/hazard_test';
const OPTS = { appBaseUrl: 'https://app.example.test' };

let sql: Sql;

beforeAll(async () => {
  const url = new URL(TEST_URL);
  const dbName = url.pathname.slice(1);
  if (!dbName.endsWith('_test')) throw new Error('Refusing to reset a database whose name does not end in _test');
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

// A 1x1 degree square around Houston, and points inside / outside it.
const SQUARE = { type: 'Polygon', coordinates: [[[-96, 29], [-95, 29], [-95, 30], [-96, 30], [-96, 29]]] };
const INSIDE: [number, number] = [-95.5, 29.5];
const INSIDE_2: [number, number] = [-95.2, 29.8];
const OUTSIDE: [number, number] = [-94.5, 29.5];
const JUST_OUTSIDE: [number, number] = [-94.9999, 29.5];

let orgId: string;
let clientId: string;
let contactId: string;
let seq = 0;

async function addProperty(name: string, [lon, lat]: [number, number], org = orgId, client = clientId): Promise<string> {
  const [row] = await sql`
    INSERT INTO properties (organization_id, client_id, name, address, location)
    VALUES (${org}, ${client}, ${name}, '1 Test St', ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)) RETURNING id`;
  return row!.id;
}

function alert(o: {
  id: string;
  severity?: string;
  type?: string;
  refs?: string[];
  geometry?: NwsAlertFeature['geometry'];
  zones?: string[];
  event?: string;
}): NormalizedAlert {
  const zones = o.zones ?? [];
  return normalizeNwsAlert({
    geometry: o.geometry === undefined ? SQUARE : o.geometry,
    properties: {
      '@id': `https://api.weather.gov/alerts/${o.id}`,
      id: o.id,
      areaDesc: 'Test area',
      geocode: { UGC: zones },
      affectedZones: zones.map((z) => `https://api.weather.gov/zones/${z[2] === 'C' ? 'county' : 'forecast'}/${z}`),
      references: (o.refs ?? []).map((identifier, i) => ({ identifier, sent: new Date(Date.UTC(2026, 0, 1, i)).toISOString() })),
      sent: new Date(Date.UTC(2026, 0, 2, 0, seq++)).toISOString(),
      expires: '2030-01-01T00:00:00Z',
      status: 'Actual',
      messageType: o.type ?? 'Alert',
      severity: o.severity ?? 'Severe',
      event: o.event ?? 'Tornado Warning',
      headline: 'Test headline',
    },
  })!;
}

const impactsFor = async (eventId: string) =>
  (await sql`SELECT property_id, severity FROM property_impacts WHERE hazard_event_id = ${eventId} ORDER BY property_id`).map(
    (r) => ({ ...r }),
  );
const notifications = async () =>
  (await sql`
    SELECT n.id, n.contact_id, n.severity, n.is_escalation, n.subject, n.body_text, n.status,
      (SELECT array_agg(property_id::text ORDER BY property_id) FROM notification_properties WHERE notification_id = n.id) AS property_ids
    FROM notifications n ORDER BY n.created_at`).map((r) => ({ ...r }));

beforeEach(async () => {
  await sql`TRUNCATE organizations, hazard_event_versions, hazard_events, geo_zones, notifications, feed_status, ingestion_runs CASCADE`;
  const [org] = await sql`INSERT INTO organizations (name, slug) VALUES ('Org', 'org') RETURNING id`;
  orgId = org!.id;
  const [client] = await sql`INSERT INTO clients (organization_id, name) VALUES (${orgId}, 'Acme') RETURNING id`;
  clientId = client!.id;
  const [contact] = await sql`
    INSERT INTO contacts (organization_id, client_id, name, email) VALUES (${orgId}, ${clientId}, 'Pat', 'pat@example.test') RETURNING id`;
  contactId = contact!.id;
  await sql`INSERT INTO alert_rules (organization_id, name, min_severity) VALUES (${orgId}, 'Default', 'moderate')`;
});

describe('spatial matching', () => {
  it('matches properties inside a polygon and not those outside', async () => {
    const inside = await addProperty('Inside', INSIDE);
    await addProperty('Outside', OUTSIDE);
    await addProperty('Just outside the edge', JUST_OUTSIDE);
    const { eventId } = await ingestAlert(sql, alert({ id: 'a1' }));
    expect(await matchEvent(sql, eventId)).toBe(1);
    expect(await impactsFor(eventId)).toEqual([{ property_id: inside, severity: 'severe' }]);
  });

  it('is idempotent: re-matching creates no duplicate impacts', async () => {
    await addProperty('Inside', INSIDE);
    const { eventId } = await ingestAlert(sql, alert({ id: 'a1' }));
    expect(await matchEvent(sql, eventId)).toBe(1);
    expect(await matchEvent(sql, eventId)).toBe(0);
    expect(await impactsFor(eventId)).toHaveLength(1);
  });

  it('matches zone-only alerts through cached zone polygons, once they arrive', async () => {
    const inside = await addProperty('Inside', INSIDE);
    await addProperty('Outside', OUTSIDE);
    const { eventId } = await ingestAlert(sql, alert({ id: 'z1', geometry: null, zones: ['TXC201'] }));

    // Zone polygon not fetched yet: no match, and the zone is reported as missing.
    expect(await matchEvent(sql, eventId)).toBe(0);
    expect(await missingZoneCodes(sql, 10)).toEqual(['TXC201']);

    await upsertZone(sql, { code: 'TXC201', kind: 'county', name: 'Harris', state: 'TX', geometry: SQUARE });
    expect(await missingZoneCodes(sql, 10)).toEqual([]);
    const [event] = await sql`SELECT zones_pending, needs_evaluation FROM hazard_events WHERE id = ${eventId}`;
    expect(event).toMatchObject({ zones_pending: false, needs_evaluation: true });

    expect(await matchEvent(sql, eventId)).toBe(1);
    expect(await impactsFor(eventId)).toEqual([{ property_id: inside, severity: 'severe' }]);
  });

  it('accepts GeometryCollection zone shapes (as NWS county zones return)', async () => {
    await addProperty('Inside', INSIDE);
    const { eventId } = await ingestAlert(sql, alert({ id: 'z2', geometry: null, zones: ['TXC201'] }));
    await upsertZone(sql, {
      code: 'TXC201',
      kind: 'county',
      name: 'Harris',
      state: 'TX',
      geometry: { type: 'GeometryCollection', geometries: [SQUARE, { type: 'Point', coordinates: [-90, 30] }] },
    });
    expect(await matchEvent(sql, eventId)).toBe(1);
  });

  it('uses the alert polygon, not the wider zone, when both exist', async () => {
    await addProperty('In zone but outside polygon', OUTSIDE);
    const wide = { type: 'Polygon', coordinates: [[[-97, 28], [-94, 28], [-94, 31], [-97, 31], [-97, 28]]] };
    await upsertZone(sql, { code: 'TXC201', kind: 'county', name: 'Harris', state: 'TX', geometry: wide });
    const { eventId } = await ingestAlert(sql, alert({ id: 'p1', zones: ['TXC201'] }));
    expect(await matchEvent(sql, eventId)).toBe(0);
  });

  it('does not match cancelled or expired events', async () => {
    await addProperty('Inside', INSIDE);
    const { eventId } = await ingestAlert(sql, alert({ id: 'a1' }));
    await ingestAlert(sql, alert({ id: 'a2', type: 'Cancel', refs: ['a1'] }));
    expect(await matchEvent(sql, eventId)).toBe(0);
  });

  it('never fetches marine zones', async () => {
    await ingestAlert(sql, alert({ id: 'm1', geometry: null, zones: ['GMZ270'], event: 'Small Craft Advisory' }));
    expect(await missingZoneCodes(sql, 10)).toEqual([]);
  });
});

describe('deduplication in the database', () => {
  it('stores the same message once', async () => {
    const first = await ingestAlert(sql, alert({ id: 'a1' }));
    const again = await ingestAlert(sql, alert({ id: 'a1' }));
    expect(first.decision.action).toBe('create');
    expect(again.decision).toEqual({ action: 'skip', eventId: first.eventId });
    const [counts] = await sql`
      SELECT (SELECT count(*)::int FROM hazard_events) AS events, (SELECT count(*)::int FROM hazard_event_versions) AS versions`;
    expect({ ...counts }).toEqual({ events: 1, versions: 1 });
  });

  it('applies updates to the original event and keeps every version', async () => {
    const first = await ingestAlert(sql, alert({ id: 'a1', severity: 'Moderate' }));
    const second = await ingestAlert(sql, alert({ id: 'a2', severity: 'Severe', type: 'Update', refs: ['a1'] }));
    const third = await ingestAlert(sql, alert({ id: 'a3', severity: 'Extreme', type: 'Update', refs: ['a1', 'a2'] }));
    expect(second.eventId).toBe(first.eventId);
    expect(third.eventId).toBe(first.eventId);
    const events = await sql`SELECT severity, current_message_id, source_event_id, status FROM hazard_events`;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ severity: 'extreme', current_message_id: 'a3', source_event_id: 'a1', status: 'active' });
    const [versions] = await sql`SELECT count(*)::int AS count FROM hazard_event_versions`;
    expect(versions!.count).toBe(3);
  });

  it('handles cancellation and keeps the event for history', async () => {
    const first = await ingestAlert(sql, alert({ id: 'a1' }));
    const cancel = await ingestAlert(sql, alert({ id: 'a2', type: 'Cancel', refs: ['a1'] }));
    expect(cancel.decision).toEqual({ action: 'cancel', eventId: first.eventId });
    const [event] = await sql`SELECT status FROM hazard_events WHERE id = ${first.eventId}`;
    expect(event!.status).toBe('cancelled');
  });

  it('expires events that drop out of the active feed, and only those', async () => {
    const a = await ingestAlert(sql, alert({ id: 'a1' }));
    const b = await ingestAlert(sql, alert({ id: 'b1' }));
    expect(await expireMissing(sql, 'nws', ['b1'])).toBe(1);
    const rows = await sql`SELECT id, status FROM hazard_events`;
    expect(rows.find((r) => r.id === a.eventId)!.status).toBe('expired');
    expect(rows.find((r) => r.id === b.eventId)!.status).toBe('active');
  });
});

describe('notifications end to end', () => {
  it('sends one grouped message per contact listing all affected properties', async () => {
    const p1 = await addProperty('Alpha', INSIDE);
    const p2 = await addProperty('Bravo', INSIDE_2);
    await addProperty('Outside', OUTSIDE);
    await ingestAlert(sql, alert({ id: 'a1' }));
    const result = await evaluatePendingEvents(sql, OPTS);
    expect(result).toMatchObject({ events: 1, impactsCreated: 2, notificationsQueued: 1 });
    const sent = await notifications();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.contact_id).toBe(contactId);
    expect(sent[0]!.property_ids).toEqual([p1, p2].sort());
    expect(sent[0]!.body_text).toContain('Alpha');
    expect(sent[0]!.body_text).toContain('Bravo');
    expect(sent[0]!.body_text).not.toContain('Outside');
    expect(sent[0]!.body_text).toContain('National Weather Service');
    expect(sent[0]!.body_text).toContain('https://app.example.test/?event=');
  });

  it('never sends a duplicate for the same event and property', async () => {
    await addProperty('Alpha', INSIDE);
    const { eventId } = await ingestAlert(sql, alert({ id: 'a1' }));
    await evaluatePendingEvents(sql, OPTS);
    // Re-evaluate repeatedly, and receive an update at the same severity.
    expect(await queueNotificationsForEvent(sql, eventId, OPTS)).toBe(0);
    await ingestAlert(sql, alert({ id: 'a2', type: 'Update', refs: ['a1'] }));
    const again = await evaluatePendingEvents(sql, OPTS);
    expect(again.notificationsQueued).toBe(0);
    expect(await notifications()).toHaveLength(1);
  });

  it('sends a follow-up only when severity escalates', async () => {
    await addProperty('Alpha', INSIDE);
    await ingestAlert(sql, alert({ id: 'a1', severity: 'Severe' }));
    await evaluatePendingEvents(sql, OPTS);

    await ingestAlert(sql, alert({ id: 'a2', severity: 'Moderate', type: 'Update', refs: ['a1'] }));
    expect((await evaluatePendingEvents(sql, OPTS)).notificationsQueued).toBe(0); // downgrade: silent

    await ingestAlert(sql, alert({ id: 'a3', severity: 'Extreme', type: 'Update', refs: ['a2', 'a1'] }));
    expect((await evaluatePendingEvents(sql, OPTS)).notificationsQueued).toBe(1);

    const sent = await notifications();
    expect(sent.map((n) => [n.severity, n.is_escalation])).toEqual([
      ['severe', false],
      ['extreme', true],
    ]);
    expect(sent[1]!.subject).toMatch(/^UPGRADED: /);
  });

  it('notifies only about newly affected properties when a property is added mid-event', async () => {
    await addProperty('Alpha', INSIDE);
    const { eventId } = await ingestAlert(sql, alert({ id: 'a1' }));
    await evaluatePendingEvents(sql, OPTS);
    const p2 = await addProperty('Bravo', INSIDE_2);
    await matchEvent(sql, eventId);
    expect(await queueNotificationsForEvent(sql, eventId, OPTS)).toBe(1);
    const sent = await notifications();
    expect(sent[1]!.property_ids).toEqual([p2]);
  });

  it('stores unknown-severity events but never notifies', async () => {
    await addProperty('Alpha', INSIDE);
    await sql`UPDATE alert_rules SET min_severity = 'minor'`;
    const { eventId } = await ingestAlert(sql, alert({ id: 'u1', severity: 'Unknown' }));
    const result = await evaluatePendingEvents(sql, OPTS);
    expect(result.impactsCreated).toBe(1);
    expect(result.notificationsQueued).toBe(0);
    const [event] = await sql`SELECT severity FROM hazard_events WHERE id = ${eventId}`;
    expect(event!.severity).toBe('unknown');
  });

  it('does not notify below a rule\'s minimum severity', async () => {
    await addProperty('Alpha', INSIDE);
    await ingestAlert(sql, alert({ id: 'a1', severity: 'Minor' }));
    expect((await evaluatePendingEvents(sql, OPTS)).notificationsQueued).toBe(0);
  });

  it('keeps organizations separate', async () => {
    await addProperty('Alpha', INSIDE);
    const [org2] = await sql`INSERT INTO organizations (name, slug) VALUES ('Other', 'other') RETURNING id`;
    const [client2] = await sql`INSERT INTO clients (organization_id, name) VALUES (${org2!.id}, 'Other client') RETURNING id`;
    await addProperty('Other org property', INSIDE_2, org2!.id, client2!.id);
    // The second organization has a contact but no rule, so only the first is notified.
    await sql`INSERT INTO contacts (organization_id, client_id, name, email) VALUES (${org2!.id}, ${client2!.id}, 'Sam', 'sam@example.test')`;
    await ingestAlert(sql, alert({ id: 'a1' }));
    const result = await evaluatePendingEvents(sql, OPTS);
    expect(result.impactsCreated).toBe(2);
    const sent = await notifications();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.contact_id).toBe(contactId);
    expect(sent[0]!.body_text).not.toContain('Other org property');
  });

  it('enforces no-duplicates at the database level', async () => {
    const p1 = await addProperty('Alpha', INSIDE);
    const { eventId } = await ingestAlert(sql, alert({ id: 'a1' }));
    await evaluatePendingEvents(sql, OPTS);
    const [n] = await sql`SELECT id FROM notifications LIMIT 1`;
    await expect(
      sql`INSERT INTO notification_properties (notification_id, contact_id, hazard_event_id, property_id, channel, severity)
          VALUES (${n!.id}, ${contactId}, ${eventId}, ${p1}, 'email', 'severe')`,
    ).rejects.toThrow(/duplicate key/);
  });
});
