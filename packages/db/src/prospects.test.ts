// Integration tests for the prospect list, against a real PostGIS database.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanProspectInput, type ProspectInput } from '@hazard/core';
import { createClient, type Sql } from './client';
import { migrate } from './migrate';
import { addPropertyProspects, addProspects, listProspects, prospectCounts } from './prospects';

const TEST_URL = (process.env.TEST_DATABASE_URL ?? 'postgres://hazard:hazard_dev@localhost:5433/hazard_test').replace(/hazard_test$/, 'hazard_test4');
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

let org: string;
let other: string;
const shop = (id: string, name: string): ProspectInput => cleanProspectInput({ id, name, kind: 'Hardware store', phone: '321-555-0100', lon: -80.7, lat: 28.4 })!;

beforeEach(async () => {
  await sql`TRUNCATE organizations CASCADE`;
  const addOrg = async (name: string) => (await sql`INSERT INTO organizations (name, slug) VALUES (${name}, ${name.toLowerCase()}) RETURNING id`)[0]!.id as string;
  org = await addOrg('Mine');
  other = await addOrg('Theirs');
});

describe('addProspects', () => {
  it('adds businesses once, however often they are sent', async () => {
    expect(await addProspects(sql, org, null, [shop('a', 'Ace'), shop('b', 'Best')], 'business', 'Flood Warning')).toEqual({ added: 2, already: 0 });
    expect(await addProspects(sql, org, null, [shop('a', 'Ace'), shop('c', 'Corner'), shop('c', 'Corner')], 'business', 'Later')).toEqual({ added: 1, already: 2 });
    const list = await listProspects(sql, org, null);
    expect(list.map((p) => p.name).sort()).toEqual(['Ace', 'Best', 'Corner']);
    expect(list.find((p) => p.name === 'Ace')!.foundIn).toBe('Flood Warning');
  });
  it('keeps each organization to its own list', async () => {
    await addProspects(sql, org, null, [shop('a', 'Ace')], 'business', '');
    expect(await addProspects(sql, other, null, [shop('a', 'Ace')], 'business', '')).toEqual({ added: 1, already: 0 });
    expect(await listProspects(sql, other, null)).toHaveLength(1);
    expect(await listProspects(sql, org, null)).toHaveLength(1);
  });
  it('lets hand-typed prospects repeat', async () => {
    const typed = cleanProspectInput({ name: 'Walk-in lead' })!;
    await addProspects(sql, org, null, [typed], 'manual', '');
    expect(await addProspects(sql, org, null, [typed], 'manual', '')).toEqual({ added: 1, already: 0 });
  });
});

describe('addPropertyProspects', () => {
  it('copies only the organization\'s own locations', async () => {
    const [mine] = await sql`INSERT INTO clients (organization_id, name) VALUES (${org}, 'Acme') RETURNING id`;
    const [theirs] = await sql`INSERT INTO clients (organization_id, name) VALUES (${other}, 'Rival') RETURNING id`;
    const add = async (o: string, c: string, name: string) =>
      (await sql`INSERT INTO properties (organization_id, client_id, name, address, city, location)
        VALUES (${o}, ${c}, ${name}, '1 Test St', 'Cocoa', ST_SetSRID(ST_MakePoint(-80.7, 28.4), 4326)) RETURNING id`)[0]!.id as string;
    const own = await add(org, mine!.id, 'Warehouse');
    const foreign = await add(other, theirs!.id, 'Depot');
    expect(await addPropertyProspects(sql, org, null, [own, foreign], 'Hurricane Warning')).toEqual({ added: 1, already: 1 });
    const [p] = await listProspects(sql, org, null);
    expect(p).toMatchObject({ name: 'Warehouse', city: 'Cocoa', source: 'property', foundIn: 'Hurricane Warning · Client: Acme', status: 'new' });
    expect(p!.lon).toBeCloseTo(-80.7);
    expect(await addPropertyProspects(sql, org, null, [own], '')).toEqual({ added: 0, already: 1 });
  });
});

describe('listProspects', () => {
  it('filters by status, counts, and puts follow-ups that are due first', async () => {
    await addProspects(sql, org, null, [shop('a', 'Ace'), shop('b', 'Best'), shop('c', 'Corner')], 'business', '');
    await sql`UPDATE prospects SET status = 'follow_up', follow_up_on = current_date - 1 WHERE source_ref = 'b'`;
    await sql`UPDATE prospects SET status = 'won' WHERE source_ref = 'c'`;
    expect((await listProspects(sql, org, null))[0]!.name).toBe('Best');
    expect((await listProspects(sql, org, 'won')).map((p) => p.name)).toEqual(['Corner']);
    expect(await prospectCounts(sql, org)).toEqual({ new: 1, follow_up: 1, won: 1 });
  });
});
