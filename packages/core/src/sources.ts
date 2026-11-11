/**
 * Normalizers for every hazard source other than NWS alerts. Each takes the raw
 * payload exactly as the source serves it and returns SourceEvents on the common
 * severity scale. Fetching lives in the worker; everything here is pure.
 *
 * The severity mappings in this file are documented in the README; change both together.
 */
import { parseCsv } from './census';
import type { GeoJsonGeometry, HazardType } from './nws';
import type { Severity } from './severity';

export type SourceId = 'nws' | 'spc' | 'mesh' | 'nhc' | 'wfigs' | 'firms' | 'nwps' | 'usgs' | 'fema';

export const SOURCE_NAMES: Record<SourceId, string> = {
  nws: 'National Weather Service',
  spc: 'NOAA Storm Prediction Center (preliminary storm report)',
  mesh: 'NOAA MRMS radar hail estimate',
  nhc: 'National Hurricane Center',
  wfigs: 'National Interagency Fire Center',
  firms: 'NASA FIRMS satellite fire detection',
  nwps: 'NOAA National Water Prediction Service',
  usgs: 'U.S. Geological Survey',
  fema: 'FEMA',
};

export interface SourceEvent {
  source: SourceId;
  /** Stable identifier of the event at the source. */
  key: string;
  /**
   * True when the source has no event identity of its own and the key names a place
   * (a river gauge). Each separate episode at that place then becomes its own event.
   */
  episodic?: boolean;
  hazardType: HazardType;
  eventName: string;
  severity: Severity;
  nativeSeverity: string | null;
  headline: string | null;
  description?: string | null;
  areaDesc: string | null;
  /** Exactly one of geometry, point or zoneCodes describes the area. */
  geometry?: GeoJsonGeometry | null;
  point?: { lon: number; lat: number };
  /** Fixed radius for this event (earthquakes). Otherwise the feed's configured buffer applies. */
  radiusMeters?: number;
  zoneCodes?: string[];
  /** Higher-severity areas to cut out of this geometry, so nested bands do not overlap. */
  subtract?: GeoJsonGeometry[];
  /** Add this geometry to what is already stored instead of replacing it (accumulating swaths). */
  mergeGeometry?: boolean;
  startsAt: string | null;
  endsAt: string | null;
  sourceUrl: string | null;
  details: Record<string, unknown>;
  raw: unknown;
}

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

// ------------------------------------------------------------------ hail / wind / tornado scales

/**
 * Hail size (inches) -> severity. Used for SPC hail reports and the MRMS radar estimate.
 *   under 1.00"          minor     (below the NWS severe threshold)
 *   1.00" to under 1.75" moderate  (quarter to under golf ball)
 *   1.75" to under 2.75" severe    (golf ball to under baseball)
 *   2.75" and larger     extreme   (baseball and larger)
 */
export function hailSeverity(inches: number): Severity {
  if (!Number.isFinite(inches) || inches <= 0) return 'unknown';
  if (inches < 1.0) return 'minor';
  if (inches < 1.75) return 'moderate';
  if (inches < 2.75) return 'severe';
  return 'extreme';
}

/**
 * Wind gust (mph) -> severity, for SPC wind reports.
 *   unknown speed (damage reported, not measured) moderate
 *   under 58 mph  minor     58-74 mph  moderate     75-99 mph  severe     100+ mph  extreme
 */
export function windSeverity(mph: number | null): Severity {
  if (mph === null || !Number.isFinite(mph)) return 'moderate';
  if (mph < 58) return 'minor';
  if (mph < 75) return 'moderate';
  if (mph < 100) return 'severe';
  return 'extreme';
}

/**
 * Tornado rating -> severity, for SPC tornado reports. Any reported tornado is at least severe.
 *   unrated, EF0, EF1  severe          EF2 and stronger  extreme
 */
export function tornadoSeverity(scale: string | null): Severity {
  const n = Number((scale ?? '').replace(/[^0-9]/g, ''));
  return (scale ?? '').match(/\d/) && n >= 2 ? 'extreme' : 'severe';
}

// ------------------------------------------------------------------ SPC storm reports

export type SpcReportKind = 'torn' | 'hail' | 'wind';

/**
 * SPC reports are grouped by "convective day": 12:00 UTC to 11:59 UTC the next day.
 * Returns the UTC date (YYYY-MM-DD) on which the convective day containing `now` began.
 */
export function convectiveDay(now: Date): string {
  const shifted = new Date(now.getTime() - 12 * HOUR);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Parse one SPC report CSV (today_torn.csv, today_hail.csv, today_wind.csv).
 * Columns: Time (HHMM UTC), Size | Speed | F_Scale, Location, County, State, Lat, Lon, Comments.
 * Hail size is in hundredths of an inch; wind speed is mph or "UNK".
 * @param day the convective day the file covers (see convectiveDay)
 */
export function parseSpcReports(csv: string, kind: SpcReportKind, day: string): SourceEvent[] {
  const rows = parseCsv(csv);
  const events: SourceEvent[] = [];
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  for (const cols of rows) {
    const [time, measure, location, county, state, latStr, lonStr, comments] = cols.map((c) => c.trim());
    if (!time || !/^\d{3,4}$/.test(time)) continue; // header or malformed row
    const lat = Number(latStr);
    const lon = Number(lonStr);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const hhmm = time.padStart(4, '0');
    const hours = Number(hhmm.slice(0, 2));
    const minutes = Number(hhmm.slice(2));
    // Times before 12:00 belong to the following calendar day.
    const at = dayStart + (hours < 12 ? 24 : 0) * HOUR + hours * HOUR + minutes * 60_000;
    const where = [location, county && `${county} County`, state].filter(Boolean).join(', ');

    let hazardType: HazardType;
    let eventName: string;
    let severity: Severity;
    const details: Record<string, unknown> = { reportType: kind };
    if (kind === 'hail') {
      const inches = Number(measure) / 100;
      hazardType = 'hail';
      severity = hailSeverity(inches);
      eventName = Number.isFinite(inches) && inches > 0 ? `Hail report: ${inches.toFixed(2)} in` : 'Hail report';
      details.hailInches = Number.isFinite(inches) ? inches : null;
    } else if (kind === 'wind') {
      const mph = /^\d+$/.test(measure ?? '') ? Number(measure) : null;
      hazardType = 'wind';
      severity = windSeverity(mph);
      eventName = mph ? `Wind report: ${mph} mph` : 'Wind damage report';
      details.windMph = mph;
    } else {
      const rated = /\d/.test(measure ?? '') ? measure! : null;
      hazardType = 'tornado';
      severity = tornadoSeverity(rated);
      eventName = rated ? `Tornado report (${rated})` : 'Tornado report';
      details.rating = rated;
    }
    events.push({
      source: 'spc',
      key: `${kind}:${day}:${hhmm}:${lat.toFixed(2)}:${lon.toFixed(2)}`,
      hazardType,
      eventName,
      severity,
      nativeSeverity: measure || null,
      headline: `${eventName} near ${where}${comments ? `. ${comments}` : ''}`,
      areaDesc: where || null,
      point: { lon, lat },
      startsAt: iso(at),
      endsAt: iso(at + 24 * HOUR),
      sourceUrl: 'https://www.spc.noaa.gov/climo/reports/today.html',
      details,
      raw: cols,
    });
  }
  return events;
}

// ------------------------------------------------------------------ USGS earthquakes

/**
 * Magnitude -> severity.
 *   under 4.0  minor     4.0-4.9  moderate     5.0-5.9  severe     6.0+  extreme
 * A USGS PAGER alert raises it: yellow to at least severe, orange or red to extreme.
 */
export function earthquakeSeverity(magnitude: number | null, pagerAlert?: string | null): Severity {
  if (magnitude === null || !Number.isFinite(magnitude)) return 'unknown';
  let severity: Severity = magnitude < 4 ? 'minor' : magnitude < 5 ? 'moderate' : magnitude < 6 ? 'severe' : 'extreme';
  if (pagerAlert === 'yellow' && (severity === 'minor' || severity === 'moderate')) severity = 'severe';
  if (pagerAlert === 'orange' || pagerAlert === 'red') severity = 'extreme';
  return severity;
}

/**
 * Radius around the epicenter treated as affected. A deliberate simplification of
 * real shaking, which depends on depth and ground conditions.
 *   under 4.0: 15 km     4.0-4.9: 40 km     5.0-5.9: 100 km     6.0-6.9: 200 km     7.0+: 300 km
 */
export function earthquakeRadiusMeters(magnitude: number): number {
  if (magnitude < 4) return 15_000;
  if (magnitude < 5) return 40_000;
  if (magnitude < 6) return 100_000;
  if (magnitude < 7) return 200_000;
  return 300_000;
}

interface UsgsFeed {
  features?: Array<{
    id: string;
    geometry: { coordinates: [number, number, number?] } | null;
    properties: { mag: number | null; place: string | null; time: number; alert: string | null; type: string; url: string; title?: string };
  }>;
}

export function parseUsgsEarthquakes(feed: UsgsFeed): SourceEvent[] {
  const events: SourceEvent[] = [];
  for (const f of feed.features ?? []) {
    const p = f.properties;
    if (p.type !== 'earthquake' || p.mag === null || !f.geometry) continue;
    const [lon, lat, depth] = f.geometry.coordinates;
    events.push({
      source: 'usgs',
      key: f.id,
      hazardType: 'earthquake',
      eventName: `Magnitude ${p.mag.toFixed(1)} earthquake`,
      severity: earthquakeSeverity(p.mag, p.alert),
      nativeSeverity: `M${p.mag}${p.alert ? ` PAGER ${p.alert}` : ''}`,
      headline: p.title ?? `M ${p.mag.toFixed(1)} - ${p.place ?? ''}`,
      areaDesc: p.place,
      point: { lon, lat },
      radiusMeters: earthquakeRadiusMeters(p.mag),
      startsAt: iso(p.time),
      endsAt: iso(p.time + 24 * HOUR),
      sourceUrl: p.url,
      details: { magnitude: p.mag, depthKm: depth ?? null, pagerAlert: p.alert },
      raw: f,
    });
  }
  return events;
}

// ------------------------------------------------------------------ NHC tropical cyclones

/**
 * Storm intensity (maximum sustained wind, knots) -> severity for properties inside the forecast cone.
 *   under 34 kt (depression)  minor        34-63 kt (tropical storm)  moderate
 *   64-95 kt (hurricane, category 1-2)  severe     96+ kt (major hurricane, category 3+)  extreme
 */
export function cycloneSeverity(knots: number | null): Severity {
  if (knots === null || !Number.isFinite(knots)) return 'unknown';
  if (knots < 34) return 'minor';
  if (knots < 64) return 'moderate';
  if (knots < 96) return 'severe';
  return 'extreme';
}

/**
 * Wind-field radius (knots) -> severity for properties inside that wind field.
 *   34 kt (tropical-storm force)  moderate     50 kt  severe     64 kt (hurricane force)  extreme
 */
export function windFieldSeverity(radiiKnots: number): Severity {
  if (radiiKnots >= 64) return 'extreme';
  if (radiiKnots >= 50) return 'severe';
  return 'moderate';
}

const CYCLONE_CLASS: Record<string, string> = {
  TD: 'Tropical Depression',
  TS: 'Tropical Storm',
  HU: 'Hurricane',
  MH: 'Major Hurricane',
  STD: 'Subtropical Depression',
  STS: 'Subtropical Storm',
  PTC: 'Post-Tropical Cyclone',
  PC: 'Potential Tropical Cyclone',
};

export interface NhcStorm {
  id: string;
  binNumber: string;
  name: string;
  classification: string;
  intensity: string;
  lastUpdate?: string;
}
interface ArcFeature {
  geometry: GeoJsonGeometry | null;
  properties: Record<string, unknown>;
}

/**
 * @param storm one entry of CurrentStorms.json
 * @param cone features of the storm's "Forecast Cone" layer
 * @param windField features of the storm's "Advisory Wind Field" layer (current 34/50/64 kt areas)
 */
export function parseNhcStorm(storm: NhcStorm, cone: ArcFeature[], windField: ArcFeature[]): SourceEvent[] {
  const knots = Number(storm.intensity);
  const label = `${CYCLONE_CLASS[storm.classification] ?? storm.classification} ${storm.name}`;
  const url = 'https://www.nhc.noaa.gov/';
  const events: SourceEvent[] = [];
  const base = { source: 'nhc' as const, hazardType: 'hurricane' as const, areaDesc: null, startsAt: storm.lastUpdate ?? null, endsAt: null, sourceUrl: url };

  const coneGeom = cone.find((f) => f.geometry)?.geometry;
  if (coneGeom) {
    events.push({
      ...base,
      key: `${storm.id}:cone`,
      eventName: `${label}: forecast cone`,
      severity: cycloneSeverity(Number.isFinite(knots) ? knots : null),
      nativeSeverity: `${storm.classification} ${storm.intensity} kt`,
      headline: `${label} (${storm.intensity} kt). The cone shows the probable track of the storm center over the next 5 days; hazards can extend well outside it.`,
      geometry: coneGeom,
      details: { stormId: storm.id, product: 'cone', intensityKt: Number.isFinite(knots) ? knots : null },
      raw: { storm, cone: cone.map((f) => f.properties) },
    });
  }

  // Strongest first, each band minus the stronger ones, so a property lands in exactly one band.
  const bands = windField
    .filter((f) => f.geometry && Number.isFinite(Number(f.properties.radii)))
    .sort((a, b) => Number(b.properties.radii) - Number(a.properties.radii));
  const stronger: GeoJsonGeometry[] = [];
  for (const f of bands) {
    const radii = Number(f.properties.radii);
    const mph = Math.round(radii * 1.15078);
    events.push({
      ...base,
      key: `${storm.id}:wind${radii}`,
      eventName: `${label}: ${mph}+ mph winds`,
      severity: windFieldSeverity(radii),
      nativeSeverity: `${radii} kt wind field`,
      headline: `Sustained winds of ${radii} kt (${mph} mph) or more from ${label}, as of the latest advisory.`,
      geometry: f.geometry,
      subtract: [...stronger],
      details: { stormId: storm.id, product: 'wind_field', radiiKt: radii },
      raw: { storm, properties: f.properties },
    });
    stronger.push(f.geometry!);
  }
  return events;
}

// ------------------------------------------------------------------ NIFC / WFIGS wildfire perimeters

/**
 * Wildfire perimeter -> severity for properties inside the perimeter or within the buffer.
 *   by size:        under 100 acres  moderate     100-4,999  severe     5,000+  extreme
 *   by containment: 90% or more contained  minor;  50-89% contained  one level lower
 */
export function wildfireSeverity(acres: number | null, percentContained: number | null): Severity {
  if (percentContained !== null && percentContained >= 90) return 'minor';
  const size = acres ?? 0;
  let level = size < 100 ? 1 : size < 5000 ? 2 : 3; // 1 moderate, 2 severe, 3 extreme
  if (percentContained !== null && percentContained >= 50) level -= 1;
  return (['minor', 'moderate', 'severe', 'extreme'] as const)[level]!;
}

export function parseWfigsPerimeters(features: ArcFeature[]): SourceEvent[] {
  const events: SourceEvent[] = [];
  for (const f of features) {
    const p = f.properties;
    const id = (p.poly_IRWINID ?? p.attr_IrwinID ?? p.attr_UniqueFireIdentifier) as string | null;
    // Prescribed burns (RX) are planned and not a hazard to notify about.
    if (!f.geometry || !id || p.attr_IncidentTypeCategory !== 'WF') continue;
    const acres = Number(p.poly_GISAcres ?? p.attr_IncidentSize);
    const contained = p.attr_PercentContained == null ? null : Number(p.attr_PercentContained);
    const name = String(p.attr_IncidentName ?? p.poly_IncidentName ?? 'Unnamed').trim();
    const size = Number.isFinite(acres) ? `${Math.round(acres).toLocaleString('en-US')} acres` : 'size unknown';
    events.push({
      source: 'wfigs',
      key: id.replace(/[{}]/g, ''),
      hazardType: 'wildfire',
      eventName: `${name} Fire`,
      severity: wildfireSeverity(Number.isFinite(acres) ? acres : null, contained),
      nativeSeverity: `${size}, ${contained === null ? 'containment not reported' : `${contained}% contained`}`,
      headline: `${name} Fire: ${size}, ${contained === null ? 'containment not reported' : `${contained}% contained`}.`,
      areaDesc: (p.attr_POOState as string | null)?.replace('US-', '') ?? null,
      geometry: f.geometry,
      startsAt: typeof p.attr_FireDiscoveryDateTime === 'number' ? iso(p.attr_FireDiscoveryDateTime) : null,
      endsAt: null,
      sourceUrl: 'https://data-nifc.opendata.arcgis.com/',
      details: { acres: Number.isFinite(acres) ? acres : null, percentContained: contained },
      raw: p,
    });
  }
  return events;
}

// ------------------------------------------------------------------ NASA FIRMS fire detections

/**
 * VIIRS detection confidence -> severity.
 *   low ("l")  minor     nominal ("n")  moderate     high ("h")  severe
 * A single satellite detection is never rated extreme; a mapped perimeter (WFIGS) can be.
 */
export function firmsSeverity(confidence: string): Severity {
  const c = confidence.trim().toLowerCase();
  if (c === 'h' || c === 'high') return 'severe';
  if (c === 'n' || c === 'nominal') return 'moderate';
  if (c === 'l' || c === 'low') return 'minor';
  // MODIS reports 0-100 instead of a letter.
  const n = Number(c);
  if (c !== '' && Number.isFinite(n)) return n >= 80 ? 'severe' : n >= 30 ? 'moderate' : 'minor';
  return 'unknown';
}

/** Parse a FIRMS area CSV. Columns are read by header name, since they differ by sensor. */
export function parseFirmsCsv(csv: string, sensor: string): SourceEvent[] {
  const rows = parseCsv(csv);
  const header = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const col = (name: string) => header.indexOf(name);
  const [iLat, iLon, iDate, iTime, iConf, iFrp, iSat] = ['latitude', 'longitude', 'acq_date', 'acq_time', 'confidence', 'frp', 'satellite'].map(col) as [number, number, number, number, number, number, number];
  if (iLat < 0 || iLon < 0 || iDate < 0 || iTime < 0) return [];
  const events: SourceEvent[] = [];
  for (const r of rows.slice(1)) {
    const lat = Number(r[iLat]);
    const lon = Number(r[iLon]);
    const date = r[iDate]?.trim();
    const time = (r[iTime] ?? '').trim().padStart(4, '0');
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !date) continue;
    const at = Date.parse(`${date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`);
    if (Number.isNaN(at)) continue;
    const confidence = iConf >= 0 ? (r[iConf] ?? '') : '';
    const frp = iFrp >= 0 ? Number(r[iFrp]) : NaN;
    events.push({
      source: 'firms',
      key: `${sensor}:${date}:${time}:${lat.toFixed(4)}:${lon.toFixed(4)}`,
      hazardType: 'wildfire',
      eventName: 'Satellite fire detection',
      severity: firmsSeverity(confidence),
      nativeSeverity: confidence ? `confidence ${confidence}` : null,
      headline: `A satellite detected heat consistent with fire at ${lat.toFixed(3)}, ${lon.toFixed(3)}. Detections can also come from industrial sites and planned burns.`,
      areaDesc: null,
      point: { lon, lat },
      startsAt: iso(at),
      endsAt: iso(at + 24 * HOUR),
      sourceUrl: 'https://firms.modaps.eosdis.nasa.gov/map/',
      details: { sensor, satellite: iSat >= 0 ? r[iSat] : null, confidence, frpMw: Number.isFinite(frp) ? frp : null },
      raw: Object.fromEntries(header.map((h, i) => [h, r[i]])),
    });
  }
  return events;
}

// ------------------------------------------------------------------ NOAA river gauges

/**
 * NOAA flood category at a river gauge -> severity.
 *   action (near flood stage)  minor     minor flooding  moderate
 *   moderate flooding          severe    major flooding  extreme
 * (NOAA's categories are shifted up one step, because any flooding at a gauge is already significant.)
 */
export function gaugeSeverity(status: string): Severity {
  switch (status.trim().toLowerCase()) {
    case 'action':
      return 'minor';
    case 'minor':
      return 'moderate';
    case 'moderate':
      return 'severe';
    case 'major':
      return 'extreme';
    default:
      return 'unknown';
  }
}

const GAUGE_LABEL: Record<string, string> = {
  action: 'near flood stage',
  minor: 'minor flooding',
  moderate: 'moderate flooding',
  major: 'major flooding',
};

export function parseRiverGauges(features: ArcFeature[]): SourceEvent[] {
  const events: SourceEvent[] = [];
  for (const f of features) {
    const p = f.properties;
    const status = String(p.status ?? '').toLowerCase();
    const lid = p.gaugelid as string | undefined;
    const lat = Number(p.latitude);
    const lon = Number(p.longitude);
    if (!lid || !(status in GAUGE_LABEL) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const place = [p.waterbody, p.location].filter(Boolean).join(' at ') || lid;
    events.push({
      source: 'nwps',
      key: lid,
      episodic: true,
      hazardType: 'flood',
      eventName: `River gauge: ${GAUGE_LABEL[status]}`,
      severity: gaugeSeverity(status),
      nativeSeverity: status,
      headline: `${place}: ${GAUGE_LABEL[status]}. Observed ${p.observed} ${p.units}; flood stage ${p.flood || 'not defined'} ${p.units}.`,
      areaDesc: [place, p.state].filter(Boolean).join(', '),
      point: { lon, lat },
      startsAt: null,
      endsAt: null,
      sourceUrl: (p.url as string) ?? null,
      details: { gauge: lid, observed: p.observed, units: p.units, floodStage: p.flood, moderateStage: p.moderate, majorStage: p.major },
      raw: p,
    });
  }
  return events;
}

// ------------------------------------------------------------------ OpenFEMA disaster declarations

/**
 * FEMA declaration type -> severity.
 *   DR (major disaster declaration)  severe
 *   EM (emergency declaration)       moderate
 *   FM (fire management assistance)  moderate
 * A declaration is an administrative act after or during an event, so it is never rated extreme.
 */
export function femaSeverity(declarationType: string): Severity {
  switch (declarationType.trim().toUpperCase()) {
    case 'DR':
      return 'severe';
    case 'EM':
    case 'FM':
      return 'moderate';
    default:
      return 'unknown';
  }
}

const FEMA_TYPE: Record<string, string> = { DR: 'Major disaster declaration', EM: 'Emergency declaration', FM: 'Fire management assistance declaration' };

export interface FemaRow {
  femaDeclarationString: string;
  disasterNumber: number;
  state: string;
  declarationType: string;
  declarationDate: string;
  incidentType: string;
  declarationTitle: string;
  fipsCountyCode: string;
  designatedArea: string;
}

/** How long a declaration stays on the map and can notify after it is made. */
export const FEMA_ACTIVE_DAYS = 30;

/** One event per declaration, covering every designated county (as NWS county zone codes, e.g. FLC005). */
export function parseFemaDeclarations(rows: FemaRow[]): SourceEvent[] {
  const byDeclaration = new Map<string, FemaRow[]>();
  for (const r of rows) {
    if (!r.femaDeclarationString) continue;
    const list = byDeclaration.get(r.femaDeclarationString) ?? [];
    list.push(r);
    byDeclaration.set(r.femaDeclarationString, list);
  }
  const events: SourceEvent[] = [];
  for (const [id, list] of byDeclaration) {
    const first = list[0]!;
    // County code 000 means a statewide or non-county designation, which has no county shape.
    const zoneCodes = [...new Set(list.filter((r) => /^\d{3}$/.test(r.fipsCountyCode) && r.fipsCountyCode !== '000').map((r) => `${r.state}C${r.fipsCountyCode}`))].sort();
    const declared = Date.parse(first.declarationDate);
    const title = first.declarationTitle?.trim() || first.incidentType;
    events.push({
      source: 'fema',
      key: id,
      hazardType: 'disaster_declaration',
      eventName: `${FEMA_TYPE[first.declarationType] ?? 'FEMA declaration'}: ${title}`,
      severity: femaSeverity(first.declarationType),
      nativeSeverity: first.declarationType,
      headline: `${id}: ${title} (${first.incidentType}), ${first.state}. ${zoneCodes.length} designated count${zoneCodes.length === 1 ? 'y' : 'ies'}.`,
      areaDesc: list.map((r) => r.designatedArea).filter(Boolean).slice(0, 12).join('; ') || first.state,
      zoneCodes,
      startsAt: Number.isNaN(declared) ? null : iso(declared),
      endsAt: Number.isNaN(declared) ? null : iso(declared + FEMA_ACTIVE_DAYS * 24 * HOUR),
      sourceUrl: `https://www.fema.gov/disaster/${first.disasterNumber}`,
      details: { declarationType: first.declarationType, incidentType: first.incidentType, state: first.state, counties: zoneCodes.length },
      raw: { declaration: id, rows: list.length },
    });
  }
  return events;
}
