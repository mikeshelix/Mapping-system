/**
 * Overture Maps places, queried in place with DuckDB. Nothing is downloaded up front and
 * there is no extra database: DuckDB reads just the parts of Overture's public files that
 * cover the map view, over HTTPS.
 *
 * DuckDB is started the first time someone asks for businesses, never at server start.
 * On that first start it installs its httpfs and spatial extensions, which needs outbound
 * access to extensions.duckdb.org once per machine.
 */
import type { DuckDBConnection } from '@duckdb/node-api';
import {
  MAX_PLACES,
  OVERTURE_CATALOG_URL,
  POI_LIMIT,
  buildAreaQuery,
  buildPoiQuery,
  cleanAreaRow,
  cleanPoiRow,
  filesForView,
  latestPlacesCollection,
  placesFileFromItem,
  placesItemUrls,
  poiFilterPattern,
  ringBounds,
  type LonLat,
  type Place,
  type PlaceCategory,
  type PlacesFile,
  type Poi,
  type ViewBox,
} from '@hazard/core';

interface Release {
  at: number;
  release: string;
  files: PlacesFile[];
}
interface State {
  connection?: Promise<DuckDBConnection>;
  release?: Promise<Release>;
  /** Queries run one at a time on the single connection. */
  queue: Promise<unknown>;
  results: Map<string, { at: number; value: PoiResult }>;
}
export interface PoiResult {
  release: string;
  places: Poi[];
  /** True when the view holds more than could be returned. */
  truncated: boolean;
}

const key = Symbol.for('hazard.web.overture');
const store = globalThis as typeof globalThis & { [key]?: State };
const state = (): State => (store[key] ??= { queue: Promise.resolve(), results: new Map() });

const RELEASE_TTL_MS = 6 * 3_600_000;
const RESULT_TTL_MS = 3_600_000;
const MAX_RESULTS_CACHED = 500;
const QUERY_TIMEOUT_MS = 45_000;
const AREA_TIMEOUT_MS = 90_000;

async function connect(): Promise<DuckDBConnection> {
  const s = state();
  s.connection ??= (async () => {
    // Imported here so the native module is only loaded when businesses are first asked for.
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const instance = await DuckDBInstance.create(':memory:', { threads: '4', memory_limit: '1GB' });
    const connection = await instance.connect();
    await connection.run('INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;');
    // Keeps each file's index in memory after its first use, which is what makes later views fast.
    await connection.run('SET enable_object_cache = true;');
    return connection;
  })();
  try {
    return await s.connection;
  } catch (error) {
    // Do not keep a failed start: the next request tries again.
    s.connection = undefined;
    throw error;
  }
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), cache: 'no-store' });
  if (!res.ok) throw new Error(`Overture catalog returned HTTP ${res.status}`);
  return res.json();
}

/** The newest release and its places files, read from the catalog and remembered for a few hours. */
async function currentRelease(): Promise<Release> {
  const s = state();
  const known = s.release ? await s.release.catch(() => null) : null;
  if (known && Date.now() - known.at < RELEASE_TTL_MS) return known;
  const loading = (async (): Promise<Release> => {
    const latest = latestPlacesCollection(await getJson(OVERTURE_CATALOG_URL));
    if (!latest) throw new Error('Overture catalog does not name a latest release');
    const items = placesItemUrls(await getJson(latest.url));
    const files = (await Promise.all(items.map(getJson))).map(placesFileFromItem).filter((f): f is PlacesFile => f !== null);
    if (files.length === 0 || files.length !== items.length) throw new Error('Overture places file list could not be read');
    return { at: Date.now(), release: latest.release, files };
  })();
  s.release = loading;
  try {
    return await loading;
  } catch (error) {
    // If the catalog is unreachable, carry on with the last release that worked.
    if (known) {
      s.release = Promise.resolve(known);
      return known;
    }
    s.release = undefined;
    throw error;
  }
}

/** Runs one query on the shared connection, after any already waiting, and gives up waiting after timeoutMs. */
async function runQuery(sql: string, params: string[], timeoutMs: number): Promise<Array<Record<string, unknown>>> {
  const s = state();
  const run = async () => {
    const connection = await connect();
    const reader = params.length ? await connection.runAndReadAll(sql, params) : await connection.runAndReadAll(sql);
    return reader.getRowObjects() as Array<Record<string, unknown>>;
  };
  const queued = s.queue.then(run, run);
  s.queue = queued.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    queued,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Overture query timed out')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface AreaResult {
  release: string;
  places: Place[];
  /** True when the area holds more businesses than one search returns. */
  truncated: boolean;
}

/** Every business inside a ring, by name. Used by "Find businesses in an area" and the alert button. */
export async function findPlacesInArea(ring: LonLat[], category: PlaceCategory): Promise<AreaResult> {
  const release = await currentRelease();
  const files = filesForView(release.files, ringBounds(ring));
  if (files.length === 0) return { release: release.release, places: [], truncated: false };
  const rows = await runQuery(buildAreaQuery(files, ring, category), [], AREA_TIMEOUT_MS);
  const places = rows.map(cleanAreaRow).filter((p): p is Place => p !== null);
  return { release: release.release, places: places.slice(0, MAX_PLACES), truncated: rows.length > MAX_PLACES };
}

export async function findPois(box: ViewBox, filter: string | null): Promise<PoiResult> {
  const s = state();
  const release = await currentRelease();
  // Views are rounded to about 100 m so small pans reuse the same answer.
  const cacheKey = [release.release, box.west.toFixed(3), box.south.toFixed(3), box.east.toFixed(3), box.north.toFixed(3), (filter ?? '').toLowerCase()].join('|');
  const cached = s.results.get(cacheKey);
  if (cached && Date.now() - cached.at < RESULT_TTL_MS) return cached.value;

  const files = filesForView(release.files, box);
  if (files.length === 0) return { release: release.release, places: [], truncated: false };
  const sql = buildPoiQuery(files, box, filter !== null);

  const rows = await runQuery(sql, filter !== null ? [poiFilterPattern(filter)] : [], QUERY_TIMEOUT_MS);
  const places = rows.map(cleanPoiRow).filter((p): p is Poi => p !== null);
  const value: PoiResult = { release: release.release, places, truncated: places.length >= POI_LIMIT };

  if (s.results.size >= MAX_RESULTS_CACHED) s.results.delete(s.results.keys().next().value as string);
  s.results.set(cacheKey, { at: Date.now(), value });
  return value;
}
