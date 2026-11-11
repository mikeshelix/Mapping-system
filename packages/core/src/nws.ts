import { mapNwsSeverity, type Severity } from './severity';

export const HAZARD_TYPES = [
  'tornado',
  'severe_thunderstorm',
  'hurricane',
  'flash_flood',
  'flood',
  'coastal',
  'winter',
  'wind',
  'fire',
  'heat',
  'cold',
  'fog',
  'marine',
  'other',
] as const;
export type HazardType = (typeof HAZARD_TYPES)[number];

export const HAZARD_LABELS: Record<HazardType, string> = {
  tornado: 'Tornado',
  severe_thunderstorm: 'Severe thunderstorm',
  hurricane: 'Hurricane / tropical',
  flash_flood: 'Flash flood',
  flood: 'Flood',
  coastal: 'Coastal',
  winter: 'Winter weather',
  wind: 'Wind',
  fire: 'Fire weather',
  heat: 'Heat',
  cold: 'Cold',
  fog: 'Fog',
  marine: 'Marine',
  other: 'Other',
};

// First match wins, so more specific patterns come first.
const HAZARD_PATTERNS: Array<[RegExp, HazardType]> = [
  [/small craft|gale|marine|hazardous seas|freezing spray|low water|hurricane force wind|^storm (warning|watch)/i, 'marine'],
  [/tornado/i, 'tornado'],
  [/severe thunderstorm/i, 'severe_thunderstorm'],
  [/hurricane|tropical|typhoon|storm surge/i, 'hurricane'],
  [/flash flood/i, 'flash_flood'],
  [/coastal flood|lakeshore flood|high surf|rip current|beach hazard|tsunami/i, 'coastal'],
  [/flood|hydrologic/i, 'flood'],
  [/winter|blizzard|snow|ice storm|freezing rain|sleet|lake effect/i, 'winter'],
  [/red flag|fire/i, 'fire'],
  [/heat/i, 'heat'],
  [/freeze|frost|cold|wind chill/i, 'cold'],
  [/wind|dust/i, 'wind'],
  [/fog/i, 'fog'],
];

// Two-letter prefixes of NWS marine zones. None collide with a state or territory code.
const MARINE_PREFIXES = new Set([
  'AM', 'AN', 'GM', 'LC', 'LE', 'LH', 'LM', 'LO', 'LS', 'PH', 'PK', 'PM', 'PS', 'PZ', 'SL',
]);

export function isMarineZone(code: string): boolean {
  return MARINE_PREFIXES.has(code.slice(0, 2).toUpperCase());
}

export function classifyNwsEvent(eventName: string, zoneCodes: string[] = []): HazardType {
  if (zoneCodes.length > 0 && zoneCodes.every(isMarineZone)) return 'marine';
  for (const [pattern, type] of HAZARD_PATTERNS) {
    if (pattern.test(eventName)) return type;
  }
  return 'other';
}

export interface GeoJsonGeometry {
  type: string;
  coordinates?: unknown;
  geometries?: unknown;
}

/** A single feature from api.weather.gov /alerts/active (GeoJSON). */
export interface NwsAlertFeature {
  id?: string;
  geometry: GeoJsonGeometry | null;
  properties: {
    '@id'?: string;
    id: string;
    areaDesc?: string | null;
    geocode?: { UGC?: string[]; SAME?: string[] };
    affectedZones?: string[];
    references?: Array<{ identifier: string; sent?: string }>;
    sent?: string | null;
    effective?: string | null;
    onset?: string | null;
    expires?: string | null;
    ends?: string | null;
    status?: string;
    messageType?: string;
    severity?: string | null;
    event?: string;
    headline?: string | null;
    description?: string | null;
    instruction?: string | null;
    parameters?: Record<string, unknown>;
  };
}

export type MessageType = 'alert' | 'update' | 'cancel';

export interface NormalizedAlert {
  source: 'nws';
  /** Identifier of this individual message. */
  messageId: string;
  /** Identifiers of earlier messages this one supersedes, most recent first. */
  references: string[];
  messageType: MessageType;
  hazardType: HazardType;
  eventName: string;
  severity: Severity;
  nativeSeverity: string | null;
  headline: string | null;
  description: string | null;
  instruction: string | null;
  areaDesc: string | null;
  geometry: GeoJsonGeometry | null;
  zoneCodes: string[];
  /** Zone code -> API URL for that zone's polygon. */
  zoneUrls: Record<string, string>;
  startsAt: string | null;
  endsAt: string | null;
  sentAt: string | null;
  sourceUrl: string | null;
  raw: NwsAlertFeature;
}

function toMessageType(value: string | undefined): MessageType {
  const v = (value ?? '').toLowerCase();
  if (v === 'cancel') return 'cancel';
  if (v === 'update') return 'update';
  return 'alert';
}

/** Returns null for anything that is not a real, public alert (tests, exercises, drafts). */
export function normalizeNwsAlert(feature: NwsAlertFeature): NormalizedAlert | null {
  const p = feature?.properties;
  if (!p?.id || !p.event) return null;
  if ((p.status ?? 'Actual').toLowerCase() !== 'actual') return null;

  const zoneCodes = [...new Set(p.geocode?.UGC ?? [])];
  const zoneUrls: Record<string, string> = {};
  for (const url of p.affectedZones ?? []) {
    const code = url.split('/').pop();
    if (code) zoneUrls[code] = url;
  }
  for (const code of Object.keys(zoneUrls)) {
    if (!zoneCodes.includes(code)) zoneCodes.push(code);
  }

  const references = [...(p.references ?? [])]
    .sort((a, b) => Date.parse(b.sent ?? '') - Date.parse(a.sent ?? '') || 0)
    .map((r) => r.identifier)
    .filter(Boolean);

  return {
    source: 'nws',
    messageId: p.id,
    references,
    messageType: toMessageType(p.messageType),
    hazardType: classifyNwsEvent(p.event, zoneCodes),
    eventName: p.event,
    severity: mapNwsSeverity(p.severity),
    nativeSeverity: p.severity ?? null,
    headline: p.headline ?? null,
    description: p.description ?? null,
    instruction: p.instruction ?? null,
    areaDesc: p.areaDesc ?? null,
    geometry: feature.geometry ?? null,
    zoneCodes,
    zoneUrls,
    startsAt: p.onset ?? p.effective ?? p.sent ?? null,
    endsAt: p.ends ?? p.expires ?? null,
    sentAt: p.sent ?? null,
    sourceUrl: p['@id'] ?? feature.id ?? null,
    raw: feature,
  };
}
