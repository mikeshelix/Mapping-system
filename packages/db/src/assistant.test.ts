// Integration tests for the assistant's tools and metering, against a real PostGIS database.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ZERO_USAGE } from '@hazard/core';
import { areaSearchesToday, assistantUsageThisMonth, propertiesInArea, recordAreaSearch, recordAssistantUsage, runAssistantTool } from './assistant';
import { createClient, type Sql } from './client';
import { migrate } from './migrate';

const TEST_URL = (process.env.TEST_DATABASE_URL ?? 'postgres://hazard:hazard_dev@localhost:5433/hazard_test').replace(/hazard_test$/, 'hazard_test3');
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

const SQUARE = { type: 'Polygon' as const, coordinates: [[[-96, 29], [-95, 29], [-95, 30], [-96, 30], [-96, 29]]] };
let org: string;
let other: string;
let acme: string;
let p: Record<string, string>;
let tornado: string;
let flood: string;
let ended: string;

async function addOrg(name: string) {
  const [o] = await sql`INSERT INTO organizations (name, slug) VALUES (${name}, ${name.toLowerCase()}) RETURNING id`;
  return o!.id as string;
}
async function addClient(organization: string, name: string) {
  const [c] = await sql`INSERT INTO clients (organization_id, name) VALUES (${organization}, ${name}) RETURNING id`;
  return c!.id as string;
}
async function addProperty(organization: string, client: string, name: string, lon: number, lat: number, extra: { state?: string; zip?: string; value?: number; type?: string; city?: string } = {}) {
  const [row] = await sql`
    INSERT INTO properties (organization_id, client_id, name, address, city, state, zip, property_type, declared_value, location)
    VALUES (${organization}, ${client}, ${name}, '1 Test St', ${extra.city ?? null}, ${extra.state ?? null}, ${extra.zip ?? null}, ${extra.type ?? null},
      ${extra.value ?? null}, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)) RETURNING id`;
  return row!.id as string;
}
async function addEvent(key: string, name: string, type: string, severity: string, status = 'active') {
  const [e] = await sql`
    INSERT INTO hazard_events (source, source_event_id, hazard_type, event_name, severity, status, headline, geometry, raw)
    VALUES ('nws', ${key}, ${type}, ${name}, ${severity}::severity, ${status}, ${name + ' headline'},
      ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(SQUARE)}), 4326), '{}') RETURNING id`;
  return e!.id as string;
}
async function addImpact(event: string, property: string, organization: string, severity: string) {
  await sql`INSERT INTO property_impacts (hazard_event_id, property_id, organization_id, severity) VALUES (${event}, ${property}, ${organization}, ${severity}::severity)`;
}
const run = async (name: string, input: unknown = {}, organization = org) => (await runAssistantTool(sql, organization, name, input)) as { result: any; map?: any };

beforeEach(async () => {
  await sql`TRUNCATE organizations, hazard_event_versions, hazard_events, geo_zones, notifications CASCADE`;
  org = await addOrg('Mine');
  other = await addOrg('Theirs');
  acme = await addClient(org, 'Acme Holdings');
  const beta = await addClient(org, 'Beta Stores');
  const rival = await addClient(other, 'Rival Co');
  p = {
    warehouse: await addProperty(org, acme, 'Houston Warehouse', -95.5, 29.5, { state: 'TX', zip: '77002', value: 1_000_000, type: 'Warehouse', city: 'Houston' }),
    office: await addProperty(org, acme, 'Houston Office', -95.2, 29.8, { state: 'TX', zip: '77002', value: 500_000, type: 'Office', city: 'Houston' }),
    store: await addProperty(org, beta, 'Dallas Store', -96.8, 32.8, { state: 'TX', zip: '75201', type: 'Retail', city: 'Dallas' }),
    seattle: await addProperty(org, beta, 'Seattle Store', -122.33, 47.6, { state: 'WA', zip: '98101', value: 250_000, type: 'Retail', city: 'Seattle' }),
    rival: await addProperty(other, rival, 'Rival Houston Depot', -95.5, 29.5, { state: 'TX', zip: '77002', value: 9_000_000 }),
  };
  tornado = await addEvent('t1', 'Tornado Warning', 'tornado', 'extreme');
  flood = await addEvent('f1', 'Flood Watch', 'flood', 'moderate');
  ended = await addEvent('w1', 'Winter Storm Warning', 'winter', 'severe', 'expired');
  await addImpact(tornado, p.warehouse!, org, 'extreme');
  await addImpact(flood, p.warehouse!, org, 'moderate');
  await addImpact(flood, p.office!, org, 'moderate');
  await addImpact(ended, p.store!, org, 'severe');
  await addImpact(tornado, p.rival!, other, 'extreme');
});

describe('assistant tools: reading the portfolio', () => {
  it('summarizes the portfolio, counting each property once at its worst severity', async () => {
    const { result } = await run('portfolio_summary');
    // Exposure with default factors: warehouse 1,000,000 x 40% + office 500,000 x 5%.
    expect(result).toEqual({ properties: 4, properties_with_declared_value: 3, total_declared_value_usd: 1_750_000, affected_now: 2, estimated_exposure_usd: 425_000 });
  });

  it('breaks the summary down by client', async () => {
    const { result } = await run('portfolio_summary', { group_by: 'client' });
    expect(result.groups).toEqual([
      { client: 'Acme Holdings', properties: 2, properties_with_declared_value: 2, total_declared_value_usd: 1_500_000, affected_now: 2, estimated_exposure_usd: 425_000 },
      { client: 'Beta Stores', properties: 2, properties_with_declared_value: 1, total_declared_value_usd: 250_000, affected_now: 0, estimated_exposure_usd: 0 },
    ]);
  });

  it('searches properties by filters and marks which are affected', async () => {
    const tx = await run('search_properties', { state: 'tx', affected: 'unaffected' });
    expect(tx.result.properties.map((r: any) => r.name)).toEqual(['Dallas Store']);
    const big = await run('search_properties', { min_declared_value: 400000 });
    expect(big.result.properties.map((r: any) => [r.name, r.worst_current_severity])).toEqual([
      ['Houston Warehouse', 'extreme'],
      ['Houston Office', 'moderate'],
    ]);
    const text = await run('search_properties', { text: 'ware' });
    expect(text.result.total_matching).toBe(1);
  });

  it('treats search text as text, not as a pattern or as SQL', async () => {
    expect((await run('search_properties', { text: '%' })).result.total_matching).toBe(0);
    expect((await run('search_properties', { client: "x' OR '1'='1" })).result.total_matching).toBe(0);
    expect((await run('search_properties', { text: '_' })).result.total_matching).toBe(0);
  });

  it('reports when a list is partial', async () => {
    const { result } = await run('search_properties', { limit: 2 });
    expect(result.properties).toHaveLength(2);
    expect(result.total_matching).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it('lists active hazards worst first, without ended ones', async () => {
    const { result } = await run('active_hazards');
    expect(result.hazards.map((h: any) => [h.name, h.severity, h.properties_affected])).toEqual([
      ['Tornado Warning', 'extreme', 1],
      ['Flood Watch', 'moderate', 2],
    ]);
    expect((await run('active_hazards', { min_severity: 'severe' })).result.total_hazards).toBe(1);
    expect((await run('active_hazards', { hazard_types: ['flood'] })).result.hazards[0].id).toBe(flood);
  });

  it('lists affected properties with distinct counts and exposure', async () => {
    const { result } = await run('affected_properties');
    expect(result.distinct_properties_affected).toBe(2);
    expect(result.hazards_involved).toBe(2);
    expect(result.total_rows).toBe(3);
    expect(result.rows[0]).toMatchObject({ property: 'Houston Warehouse', severity: 'extreme', hazard: 'Tornado Warning', estimated_exposure_usd: 400_000, property_id: p.warehouse });
    const one = await run('affected_properties', { event_id: flood });
    expect(one.result.rows.map((r: any) => r.property).sort()).toEqual(['Houston Office', 'Houston Warehouse']);
    expect((await run('affected_properties', { event_id: 'not-an-id' })).result.error).toBeTruthy();
  });

  it('counts history including ended hazards', async () => {
    const { result } = await run('hazard_history', { days: 30 });
    expect(result.distinct_hazards).toBe(3);
    expect(result.distinct_properties_affected).toBe(3);
    expect(result.groups.map((g: any) => g.hazard_type).sort()).toEqual(['flood', 'tornado', 'winter']);
    expect(result.records_begin).toBeTruthy();
    const byClient = await run('hazard_history', { group_by: 'client', hazard_types: ['winter'] });
    expect(byClient.result.groups).toEqual([{ client: 'Beta Stores', hazards: 1, properties_affected: 1, worst_severity: 'severe' }]);
  });

  it('summarizes notifications by contact name without exposing addresses', async () => {
    const [contact] = await sql`INSERT INTO contacts (organization_id, client_id, name, email, mobile) VALUES (${org}, ${acme}, 'Pat Tester', 'pat@example.test', '+15555550100') RETURNING id`;
    const [note] = await sql`
      INSERT INTO notifications (organization_id, contact_id, hazard_event_id, channel, severity, recipient, body_text, status, sent_at)
      VALUES (${org}, ${contact!.id}, ${tornado}, 'email', 'extreme', 'pat@example.test', 'body', 'sent', now()) RETURNING id`;
    await sql`
      INSERT INTO notification_properties (notification_id, contact_id, hazard_event_id, property_id, channel, severity)
      VALUES (${note!.id}, ${contact!.id}, ${tornado}, ${p.warehouse!}, 'email', 'extreme')`;
    // Narrowing to a property keeps messages that covered it and drops the rest.
    expect((await run('notification_summary', { property_id: p.warehouse })).result.most_recent).toHaveLength(1);
    expect((await run('notification_summary', { property_id: p.office })).result.most_recent).toHaveLength(0);
    const { result } = await run('notification_summary', { days: 7 });
    expect(result.counts).toEqual([{ channel: 'email', status: 'sent', messages: 1, contacts: 1 }]);
    expect(result.most_recent[0]).toMatchObject({ contact: 'Pat Tester', hazard: 'Tornado Warning', channel: 'email' });
    expect(JSON.stringify(result)).not.toContain('pat@example.test');
    expect(JSON.stringify(result)).not.toContain('5555550100');
  });
});

describe('assistant tools: staying inside one organization', () => {
  it("never returns another organization's properties, whatever is asked", async () => {
    for (const [name, input] of [
      ['search_properties', { text: 'Rival' }],
      ['search_properties', {}],
      ['affected_properties', {}],
      ['portfolio_summary', { group_by: 'client' }],
      ['hazard_history', { group_by: 'client' }],
    ] as const) {
      expect(JSON.stringify((await run(name, input)).result)).not.toContain('Rival');
    }
    expect((await run('portfolio_summary', {}, other)).result.properties).toBe(1);
  });

  it("will not put another organization's property on the map", async () => {
    const mixed = await run('show_on_map', { property_ids: [p.rival, p.warehouse], title: 'Mixed' });
    expect(mixed.map.points.map((x: any) => x.id)).toEqual([p.warehouse]);
    const onlyTheirs = await run('show_on_map', { property_ids: [p.rival], title: 'Theirs' });
    expect(onlyTheirs.map).toBeUndefined();
    expect(onlyTheirs.result.shown).toBe(false);
  });

  it('cannot write: the tools run in a read-only transaction', async () => {
    await expect(
      sql.begin('read only', async (tx) => {
        await tx`UPDATE properties SET name = 'changed' WHERE id = ${p.warehouse!}`;
      }),
    ).rejects.toThrow(/read-only/);
  });

  it('answers unknown tools and unknown organizations with an error result, not a crash', async () => {
    expect((await run('delete_everything')).result.error).toContain('Unknown tool');
    expect((await run('portfolio_summary', {}, '00000000-0000-4000-8000-000000000000')).result.error).toBeTruthy();
  });
});

describe('show_on_map', () => {
  it('returns points for properties and the frame of a hazard', async () => {
    const { result, map } = await run('show_on_map', { property_ids: [p.warehouse, p.office, 'junk'], event_id: tornado, title: 'Tornado properties' });
    expect(result).toEqual({ shown: true, properties_highlighted: 2, hazard_outlined: 'Tornado Warning' });
    expect(map.title).toBe('Tornado properties');
    expect(map.points.map((x: any) => x.name).sort()).toEqual(['Houston Office', 'Houston Warehouse']);
    expect(map.eventId).toBe(tornado);
    expect(map.bbox).toEqual([-96, 29, -95, 30]);
  });
});

describe('metering', () => {
  it('records each question with its cost and totals the month', async () => {
    const base = { organizationId: org, userId: null, question: 'How many?', model: 'claude-opus-5-5', requests: 2, toolCalls: 1, durationMs: 900 };
    const cost = await recordAssistantUsage(sql, { ...base, status: 'ok', usage: { inputTokens: 10000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    expect(cost).toBe(0.06);
    await recordAssistantUsage(sql, { ...base, status: 'ok', usage: { inputTokens: 5000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    await recordAssistantUsage(sql, { ...base, status: 'error', usage: ZERO_USAGE, error: 'boom' });
    await recordAssistantUsage(sql, { ...base, organizationId: other, status: 'ok', usage: { inputTokens: 100000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    const mine = await assistantUsageThisMonth(sql, org);
    expect(mine).toMatchObject({ questions: 3, answered: 2, inputTokens: 15000, outputTokens: 1500, highestCostUsd: 0.06 });
    expect(mine.costUsd).toBeCloseTo(0.09, 6);
    expect(mine.averageCostUsd).toBeCloseTo(0.045, 6);
    const all = await assistantUsageThisMonth(sql, null);
    expect(all.questions).toBe(4);
    expect(all.costUsd).toBeCloseTo(0.49, 6);
  });

  it('stores an unknown-price model with no dollar figure', async () => {
    const cost = await recordAssistantUsage(sql, { organizationId: org, userId: null, question: 'q', model: 'mystery', status: 'ok', requests: 1, toolCalls: 0, usage: { ...ZERO_USAGE, inputTokens: 5 }, durationMs: 1 });
    expect(cost).toBeNull();
    expect((await assistantUsageThisMonth(sql, org)).costUsd).toBe(0);
  });
});

describe('area searches', () => {
  it("finds only this organization's properties inside the shape", async () => {
    const inside = await propertiesInArea(sql, org, SQUARE);
    expect(inside.map((x) => x.name)).toEqual(['Houston Office', 'Houston Warehouse']);
    expect(inside[0]).toMatchObject({ client: 'Acme Holdings', lon: -95.2, lat: 29.8 });
  });

  it('logs searches and counts the day', async () => {
    expect(await areaSearchesToday(sql, org)).toBe(0);
    await recordAreaSearch(sql, { organizationId: org, userId: null, polygon: SQUARE, category: 'all', source: 'osm-overpass', resultCount: 12, status: 'ok', durationMs: 800 });
    await recordAreaSearch(sql, { organizationId: other, userId: null, polygon: SQUARE, category: 'food', source: 'osm-overpass', resultCount: 0, status: 'error', error: 'HTTP 504', durationMs: 800 });
    expect(await areaSearchesToday(sql, org)).toBe(1);
  });
});
