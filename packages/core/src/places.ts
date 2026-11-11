/**
 * Phase 4: businesses inside a drawn area, from OpenStreetMap through the
 * Overpass API. Pure: validates the shape, builds the query, reads the reply.
 *
 * Verified against the live service and documentation on 2026-11-10:
 *   endpoint  https://overpass-api.de/api/interpreter (POST, form field "data")
 *   policy    https://dev.overpass-api.de/overpass-doc/en/preface/commons.html
 *             "a maximum of about 10000 requests per day" and under about 1 GB per day
 *   licence   OpenStreetMap data, ODbL: results must credit "© OpenStreetMap contributors"
 */

export type LonLat = [number, number];

export const PLACE_CATEGORIES = ['all', 'retail', 'food', 'office', 'lodging', 'health', 'automotive', 'trades', 'other'] as const;
export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];

export const PLACE_CATEGORY_LABELS: Record<PlaceCategory, string> = {
  all: 'All businesses',
  retail: 'Shops and retail',
  food: 'Restaurants and bars',
  office: 'Offices and banks',
  lodging: 'Hotels and lodging',
  health: 'Health care',
  automotive: 'Automotive',
  trades: 'Trades and workshops',
  other: 'Leisure and other',
};

export const PLACES_ATTRIBUTION = '© OpenStreetMap contributors';
export const PLACES_NOTE =
  'From OpenStreetMap, a volunteer-maintained map. Coverage varies by area: some businesses will be missing or out of date.';

/** Largest area that may be searched in one go, in square miles. Keeps each request small. */
export const MAX_AREA_SQ_MILES = 100;
export const MAX_VERTICES = 200;
export const MAX_PLACES = 2000;

const EARTH_RADIUS_M = 6_371_008.8;
const SQ_M_PER_SQ_MILE = 2_589_988.110336;

/** Area of a lon/lat ring on the sphere, in square miles. The ring may be open or closed. */
export function ringAreaSqMiles(ring: LonLat[]): number {
  if (ring.length < 3) return 0;
  const rad = (d: number) => (d * Math.PI) / 180;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lon1, lat1] = ring[i]!;
    const [lon2, lat2] = ring[(i + 1) % ring.length]!;
    sum += rad(lon2 - lon1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return Math.abs((sum * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2) / SQ_M_PER_SQ_MILE;
}

export type ShapeCheck = { ok: true; ring: LonLat[]; areaSqMiles: number } | { ok: false; error: string };

/** Accepts the drawn points (open or closed ring) and returns a clean open ring, or why it cannot be searched. */
export function checkShape(input: unknown): ShapeCheck {
  if (!Array.isArray(input)) return { ok: false, error: 'Draw an area on the map first.' };
  const ring: LonLat[] = [];
  for (const p of input) {
    if (!Array.isArray(p) || p.length < 2) return { ok: false, error: 'The drawn area is not valid.' };
    const lon = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      return { ok: false, error: 'The drawn area is not valid.' };
    }
    const prev = ring[ring.length - 1];
    if (prev && prev[0] === lon && prev[1] === lat) continue;
    ring.push([lon, lat]);
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (ring.length > 1 && first && last && first[0] === last[0] && first[1] === last[1]) ring.pop();
  if (ring.length < 3) return { ok: false, error: 'An area needs at least three points.' };
  if (ring.length > MAX_VERTICES) return { ok: false, error: `An area can have at most ${MAX_VERTICES} points.` };
  const areaSqMiles = ringAreaSqMiles(ring);
  if (areaSqMiles <= 0) return { ok: false, error: 'The drawn area is empty.' };
  if (areaSqMiles > MAX_AREA_SQ_MILES) {
    return { ok: false, error: `That area is about ${Math.round(areaSqMiles).toLocaleString()} square miles. Draw one of ${MAX_AREA_SQ_MILES} square miles or less.` };
  }
  return { ok: true, ring, areaSqMiles };
}

/** GeoJSON polygon (closed ring) for a checked shape. */
export function ringToPolygon(ring: LonLat[]): { type: 'Polygon'; coordinates: LonLat[][] } {
  return { type: 'Polygon', coordinates: [[...ring, ring[0]!]] };
}

// ------------------------------------------------------------------ what counts as a business

const FOOD = ['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'food_court', 'ice_cream', 'biergarten'];
const HEALTH = ['clinic', 'dentist', 'doctors', 'hospital', 'pharmacy', 'veterinary'];
const AUTO_AMENITY = ['fuel', 'car_wash', 'car_rental', 'vehicle_inspection'];
const OFFICE_AMENITY = ['bank', 'bureau_de_change', 'money_transfer'];
const OTHER_AMENITY = ['cinema', 'theatre', 'nightclub', 'casino', 'childcare', 'events_venue', 'studio', 'driving_school', 'funeral_home', 'marketplace', 'conference_centre'];
const LODGING = ['hotel', 'motel', 'guest_house', 'hostel', 'apartments', 'chalet', 'camp_site', 'caravan_site'];
const LEISURE = ['fitness_centre', 'bowling_alley', 'sports_centre', 'golf_course', 'marina', 'amusement_arcade', 'trampoline_park', 'escape_game'];
const AUTO_SHOP = ['car', 'car_repair', 'car_parts', 'tyres', 'motorcycle', 'truck', 'trailer'];

/** Which category an OpenStreetMap feature belongs to, or null when it is not a business. */
export function classifyPlace(tags: Record<string, string>): Exclude<PlaceCategory, 'all'> | null {
  const { shop, amenity, office, craft, tourism, healthcare, leisure } = tags;
  if (shop && shop !== 'vacant' && shop !== 'no') return AUTO_SHOP.includes(shop) ? 'automotive' : 'retail';
  if (amenity) {
    if (FOOD.includes(amenity)) return 'food';
    if (HEALTH.includes(amenity)) return 'health';
    if (AUTO_AMENITY.includes(amenity)) return 'automotive';
    if (OFFICE_AMENITY.includes(amenity)) return 'office';
    if (OTHER_AMENITY.includes(amenity)) return 'other';
  }
  if (healthcare) return 'health';
  if (office && office !== 'no') return 'office';
  if (craft) return 'trades';
  if (tourism && LODGING.includes(tourism)) return 'lodging';
  if (leisure && LEISURE.includes(leisure)) return 'other';
  return null;
}

const any = (values: string[]) => `~"^(${values.join('|')})$"`;

/** Overpass filters, per category. Every filter also requires a name: unnamed features are rarely businesses. */
const SELECTORS: Record<Exclude<PlaceCategory, 'all'>, string[]> = {
  retail: ['["shop"]'],
  food: [`["amenity"${any(FOOD)}]`],
  office: ['["office"]', `["amenity"${any(OFFICE_AMENITY)}]`],
  lodging: [`["tourism"${any(LODGING)}]`],
  health: ['["healthcare"]', `["amenity"${any(HEALTH)}]`],
  automotive: [`["shop"${any(AUTO_SHOP)}]`, `["amenity"${any(AUTO_AMENITY)}]`],
  trades: ['["craft"]'],
  other: [`["leisure"${any(LEISURE)}]`, `["amenity"${any(OTHER_AMENITY)}]`],
};

/** The Overpass QL query for businesses of a category inside a ring. */
export function buildOverpassQuery(ring: LonLat[], category: PlaceCategory, timeoutSeconds = 25): string {
  // Overpass wants "lat lon" pairs; six decimals is about four inches.
  const poly = ring.map(([lon, lat]) => `${lat.toFixed(6)} ${lon.toFixed(6)}`).join(' ');
  const cats = category === 'all' ? (Object.keys(SELECTORS) as Array<keyof typeof SELECTORS>).filter((c) => c !== 'automotive') : [category];
  // "automotive" shops are already matched by the retail ["shop"] filter when searching everything.
  const selectors = [...new Set(cats.flatMap((c) => SELECTORS[c]))];
  if (category === 'all') selectors.push(`["amenity"${any(AUTO_AMENITY)}]`);
  const body = selectors.map((s) => `nwr["name"]${s}(poly:"${poly}");`).join('');
  return `[out:json][timeout:${timeoutSeconds}];(${body});out center tags ${MAX_PLACES};`;
}

// ------------------------------------------------------------------ reading the reply

export interface Place {
  id: string;
  name: string;
  category: Exclude<PlaceCategory, 'all'>;
  kind: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  website: string;
  lon: number;
  lat: number;
  url: string;
}

interface OverpassElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

/** Only http(s) links are passed on; anything else in the data is dropped. */
function safeUrl(value: string | undefined): string {
  if (!value) return '';
  const v = value.trim();
  const withScheme = /^https?:\/\//i.test(v) ? v : /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(v) ? `https://${v}` : '';
  try {
    return withScheme ? new URL(withScheme).toString() : '';
  } catch {
    return '';
  }
}

/** Turns an Overpass reply into businesses, dropping anything unnamed, unplaced or not a business. Sorted by name. */
export function parseOverpass(reply: unknown, category: PlaceCategory = 'all'): Place[] {
  const elements = (reply as { elements?: unknown })?.elements;
  if (!Array.isArray(elements)) throw new Error('Unexpected reply from the business data service');
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const el of elements as OverpassElement[]) {
    const tags = el.tags ?? {};
    const name = tags.name?.trim();
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!name || typeof lat !== 'number' || typeof lon !== 'number' || !el.type || el.id === undefined) continue;
    const cat = classifyPlace(tags);
    if (!cat || (category !== 'all' && cat !== category)) continue;
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const kind = tags.shop ?? tags.amenity ?? tags.healthcare ?? tags.office ?? tags.craft ?? tags.tourism ?? tags.leisure ?? '';
    out.push({
      id,
      name,
      category: cat,
      kind: kind.replace(/_/g, ' '),
      address: [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
      city: tags['addr:city'] ?? '',
      state: tags['addr:state'] ?? '',
      zip: (tags['addr:postcode'] ?? '').slice(0, 10),
      phone: tags.phone ?? tags['contact:phone'] ?? '',
      website: safeUrl(tags.website ?? tags['contact:website']),
      lon,
      lat,
      url: `https://www.openstreetmap.org/${id}`,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const DEFAULT_AREA_SEARCH_DAILY_CAP = 200;

/** Most area searches an organization may run in a day, so the shared free service is not overused. */
export function readAreaSearchCap(settings: unknown): number {
  const v = ((settings ?? {}) as { areaSearchDailyCap?: unknown }).areaSearchDailyCap;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_AREA_SEARCH_DAILY_CAP;
}
