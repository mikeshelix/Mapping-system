/**
 * Phase 2 hazard feeds. Each collector fetches one source and returns normalized
 * events; runFeed() stores them, expires what has ended, and logs the run.
 * Endpoints were verified against the live services on 2026-11-10.
 */
import {
  convectiveDay,
  parseFemaDeclarations,
  parseFirmsCsv,
  parseNhcStorm,
  parseRiverGauges,
  parseSpcReports,
  parseUsgsEarthquakes,
  parseWfigsPerimeters,
  FEMA_ACTIVE_DAYS,
  type FemaRow,
  type GeoJsonGeometry,
  type NhcStorm,
  type SourceEvent,
  type SourceId,
  type SpcReportKind,
} from '@hazard/core';
import { expireEnded, expireMissingKeys, finishRun, getFeedSettings, startRun, upsertSourceEvent, type Sql } from '@hazard/db';
import { errorMessage, fetchWithRetry, HttpError, log } from '../util';
import { decodeMrmsGrib, meshEvents } from './mesh';

const UA = () => ({ 'User-Agent': process.env.NWS_USER_AGENT || 'HelixcoWeatherApp/1.0' });

async function getText(url: string, timeoutMs = 60_000): Promise<string> {
  const res = await fetchWithRetry(url, { headers: UA() }, { timeoutMs });
  if (!res.ok) throw new HttpError(res.status, url.split('?')[0]!);
  return res.text();
}
async function getJson<T>(url: string, timeoutMs = 60_000): Promise<T> {
  return JSON.parse(await getText(url, timeoutMs)) as T;
}

interface ArcFeature {
  geometry: GeoJsonGeometry | null;
  properties: Record<string, unknown>;
}
interface ArcGeoJson {
  features?: ArcFeature[];
  exceededTransferLimit?: boolean;
  properties?: { exceededTransferLimit?: boolean };
  error?: { message?: string };
}

/** Query an ArcGIS layer as GeoJSON, following pagination. */
async function arcgisQuery(layerUrl: string, where: string, outFields = '*'): Promise<ArcFeature[]> {
  const all: ArcFeature[] = [];
  for (let offset = 0, page = 0; page < 50; page++) {
    const url = `${layerUrl}/query?where=${encodeURIComponent(where)}&outFields=${encodeURIComponent(outFields)}&outSR=4326&f=geojson&resultOffset=${offset}`;
    const json = await getJson<ArcGeoJson>(url, 120_000);
    if (json.error || !Array.isArray(json.features)) throw new Error(`ArcGIS query failed: ${json.error?.message ?? 'no features array'}`);
    all.push(...json.features);
    if (!(json.exceededTransferLimit || json.properties?.exceededTransferLimit) || json.features.length === 0) break;
    offset += json.features.length;
  }
  return all;
}

export interface Collected {
  events: SourceEvent[];
  /** True when the source lists everything currently in effect, so anything not listed has ended. */
  listsAllActive: boolean;
}

// ------------------------------------------------------------------ collectors

/** SPC preliminary storm reports. https://www.spc.noaa.gov/climo/reports/ */
async function collectSpc(): Promise<Collected> {
  const today = convectiveDay(new Date());
  const yesterday = convectiveDay(new Date(Date.now() - 86_400_000));
  const events: SourceEvent[] = [];
  for (const [file, day] of [['today', today], ['yesterday', yesterday]] as const) {
    for (const kind of ['torn', 'hail', 'wind'] as SpcReportKind[]) {
      events.push(...parseSpcReports(await getText(`https://www.spc.noaa.gov/climo/reports/${file}_${kind}.csv`), kind, day));
    }
  }
  return { events, listsAllActive: false };
}

/** USGS earthquakes, magnitude 2.5+ in the past day. https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php */
async function collectUsgs(): Promise<Collected> {
  const feed = await getJson<Parameters<typeof parseUsgsEarthquakes>[0]>('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson');
  if (!Array.isArray(feed.features)) throw new Error('USGS feed has no features array');
  return { events: parseUsgsEarthquakes(feed), listsAllActive: false };
}

const NHC_SERVICE = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
let nhcLayers: Map<string, number> | null = null;

/** NHC active storms, with forecast cone and current wind field from NOAA's map service. */
async function collectNhc(): Promise<Collected> {
  const current = await getJson<{ activeStorms?: NhcStorm[] }>('https://www.nhc.noaa.gov/CurrentStorms.json');
  if (!Array.isArray(current.activeStorms)) throw new Error('CurrentStorms.json has no activeStorms array');
  const events: SourceEvent[] = [];
  if (current.activeStorms.length && !nhcLayers) {
    const service = await getJson<{ layers: Array<{ id: number; name: string }> }>(`${NHC_SERVICE}?f=json`);
    nhcLayers = new Map(service.layers.map((l) => [l.name, l.id]));
  }
  for (const storm of current.activeStorms) {
    const cone = nhcLayers?.get(`${storm.binNumber} Forecast Cone`);
    const wind = nhcLayers?.get(`${storm.binNumber} Advisory Wind Field`);
    if (cone === undefined || wind === undefined) {
      log('warn', 'nhc layers not found for storm', { bin: storm.binNumber });
      continue;
    }
    events.push(...parseNhcStorm(storm, await arcgisQuery(`${NHC_SERVICE}/${cone}`, '1=1'), await arcgisQuery(`${NHC_SERVICE}/${wind}`, '1=1')));
  }
  return { events, listsAllActive: true };
}

const WFIGS_LAYER =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0';

/** NIFC / WFIGS current wildfire perimeters. */
async function collectWfigs(): Promise<Collected> {
  const fields = 'poly_IRWINID,poly_IncidentName,poly_GISAcres,attr_IncidentName,attr_IncidentSize,attr_PercentContained,attr_IncidentTypeCategory,attr_FireDiscoveryDateTime,attr_POOState,attr_UniqueFireIdentifier';
  return { events: parseWfigsPerimeters(await arcgisQuery(WFIGS_LAYER, "attr_IncidentTypeCategory='WF'", fields)), listsAllActive: true };
}

// The Suomi-NPP satellite stopped delivering data on 2026-11-02; NOAA-20 and NOAA-21 carry the same sensor.
const FIRMS_SENSORS = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'];
// west,south,east,north: lower 48, Alaska, Hawaii.
const FIRMS_AREAS = ['-125,24,-66,49.5', '-170,51,-129,72', '-161,18,-154,23'];

/** NASA FIRMS satellite fire detections. Needs a free MAP_KEY. https://firms.modaps.eosdis.nasa.gov/api/area/ */
async function collectFirms(): Promise<Collected> {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) throw new Error('FIRMS_MAP_KEY is not set');
  const events: SourceEvent[] = [];
  for (const sensor of FIRMS_SENSORS) {
    for (const area of FIRMS_AREAS) {
      const res = await fetchWithRetry(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${sensor}/${area}/1`, { headers: UA() });
      // Never include the URL in an error: it contains the key.
      if (!res.ok) throw new Error(`FIRMS returned HTTP ${res.status}`);
      const text = await res.text();
      if (/invalid/i.test(text.slice(0, 80))) throw new Error(`FIRMS rejected the request: ${text.slice(0, 80)}`);
      events.push(...parseFirmsCsv(text, sensor));
    }
  }
  return { events, listsAllActive: false };
}

const GAUGE_LAYER = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer/0';

/** NOAA river gauges currently at action stage or in flood. */
async function collectGauges(): Promise<Collected> {
  return { events: parseRiverGauges(await arcgisQuery(GAUGE_LAYER, "status IN ('action','minor','moderate','major')")), listsAllActive: true };
}

/** OpenFEMA disaster declarations from the last 30 days. https://www.fema.gov/about/openfema/api */
async function collectFema(): Promise<Collected> {
  const since = new Date(Date.now() - FEMA_ACTIVE_DAYS * 86_400_000).toISOString();
  const rows: FemaRow[] = [];
  for (let skip = 0, page = 0; page < 20; page++, skip += 1000) {
    const url = `https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$filter=${encodeURIComponent(`declarationDate ge '${since}'`)}&$orderby=declarationDate&$top=1000&$skip=${skip}`;
    const json = await getJson<{ DisasterDeclarationsSummaries?: FemaRow[] }>(url);
    if (!Array.isArray(json.DisasterDeclarationsSummaries)) throw new Error('OpenFEMA response has no DisasterDeclarationsSummaries array');
    rows.push(...json.DisasterDeclarationsSummaries);
    if (json.DisasterDeclarationsSummaries.length < 1000) break;
  }
  return { events: parseFemaDeclarations(rows), listsAllActive: false };
}

const MESH_DIR = 'https://mrms.ncep.noaa.gov/2D/MESH_Max_60min/';
let lastMeshFile: string | null = null;

/** NOAA MRMS radar-estimated hail (see mesh.ts). */
async function collectMesh(): Promise<Collected> {
  const listing = await getText(MESH_DIR);
  const files = listing.match(/MRMS_MESH_Max_60min_[\d.]+_\d{8}-\d{6}\.grib2\.gz/g);
  const latest = files?.sort().at(-1);
  if (!latest) throw new Error('No MESH files listed');
  if (latest === lastMeshFile) return { events: [], listsAllActive: false };
  const res = await fetchWithRetry(MESH_DIR + latest, { headers: UA() }, { timeoutMs: 60_000 });
  if (!res.ok) throw new HttpError(res.status, MESH_DIR);
  const events = meshEvents(decodeMrmsGrib(Buffer.from(await res.arrayBuffer())));
  lastMeshFile = latest;
  return { events, listsAllActive: false };
}

// ------------------------------------------------------------------ registry

export interface FeedDefinition {
  feed: SourceId;
  pollSeconds: number;
  staleAfterSeconds: number;
  collect: () => Promise<Collected>;
  /** False when the feed cannot run in this environment (missing key). */
  available?: () => boolean;
}

export const FEEDS: FeedDefinition[] = [
  { feed: 'spc', pollSeconds: 600, staleAfterSeconds: 3600, collect: collectSpc },
  { feed: 'mesh', pollSeconds: 600, staleAfterSeconds: 3600, collect: collectMesh },
  { feed: 'usgs', pollSeconds: 300, staleAfterSeconds: 1800, collect: collectUsgs },
  { feed: 'nhc', pollSeconds: 900, staleAfterSeconds: 7200, collect: collectNhc },
  { feed: 'nwps', pollSeconds: 900, staleAfterSeconds: 5400, collect: collectGauges },
  { feed: 'wfigs', pollSeconds: 1800, staleAfterSeconds: 10_800, collect: collectWfigs },
  { feed: 'firms', pollSeconds: 900, staleAfterSeconds: 7200, collect: collectFirms, available: () => !!process.env.FIRMS_MAP_KEY },
  { feed: 'fema', pollSeconds: 21_600, staleAfterSeconds: 129_600, collect: collectFema },
];

/** Run one feed: collect, store, expire, and record the run. Throws on failure so the scheduler backs off. */
export async function runFeed(sql: Sql, def: FeedDefinition): Promise<void> {
  const setting = (await getFeedSettings(sql)).get(def.feed);
  if (setting && !setting.enabled) return;
  const runId = await startRun(sql, def.feed);
  try {
    const { events, listsAllActive } = await def.collect();
    const counts = { create: 0, update: 0, skip: 0, failed: 0 };
    for (const event of events) {
      try {
        counts[await upsertSourceEvent(sql, event, { bufferMeters: setting?.bufferMeters ?? null })]++;
      } catch (err) {
        counts.failed++;
        if (counts.failed <= 3) log('error', 'event store failed', { feed: def.feed, key: event.key, error: errorMessage(err) });
      }
    }
    let expired = 0;
    if (listsAllActive) expired = await expireMissingKeys(sql, def.feed, events.map((e) => e.key));
    expired += await expireEnded(sql);
    await finishRun(sql, def.feed, runId, {
      status: 'ok',
      httpStatus: 200,
      eventsSeen: events.length,
      eventsNew: counts.create,
      eventsUpdated: counts.update,
      eventsExpired: expired,
      error: counts.failed ? `${counts.failed} event(s) failed to store` : null,
    });
    if (counts.create || counts.update || expired) log('info', 'feed poll', { feed: def.feed, seen: events.length, ...counts, expired });
  } catch (err) {
    await finishRun(sql, def.feed, runId, {
      status: 'error',
      httpStatus: err instanceof HttpError ? err.status : null,
      error: errorMessage(err),
    });
    throw err;
  }
}
