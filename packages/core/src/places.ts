/**
 * Businesses inside a drawn area or an alert. Pure: validates the shape and defines the
 * categories and the shape of a result. The data is Overture Maps places, queried with
 * DuckDB (see poi.ts for the query and apps/web/src/lib/overture.ts for running it).
 *
 * Categories are Overture's own top-level groups (taxonomy.hierarchy[1]), sampled from the
 * live data on 2026-11-23.
 */

export type LonLat = [number, number];

export const PLACE_CATEGORIES = ['all', 'services', 'retail', 'food', 'health', 'personal', 'lodging', 'travel', 'recreation', 'community'] as const;
export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];

export const PLACE_CATEGORY_LABELS: Record<PlaceCategory, string> = {
  all: 'All businesses',
  services: 'Business and professional services',
  retail: 'Shops and retail',
  food: 'Restaurants, bars and food',
  health: 'Health care',
  personal: 'Personal services (salons, pet care)',
  lodging: 'Hotels and lodging',
  travel: 'Fuel, parking and transport',
  recreation: 'Sports, arts and entertainment',
  community: 'Schools, worship and government',
};

/** Which of Overture's top-level groups make up each category. */
export const PLACE_CATEGORY_GROUPS: Record<Exclude<PlaceCategory, 'all'>, readonly string[]> = {
  services: ['services_and_business'],
  retail: ['shopping'],
  food: ['food_and_drink'],
  health: ['health_care'],
  personal: ['lifestyle_services'],
  lodging: ['lodging'],
  travel: ['travel_and_transportation'],
  recreation: ['sports_and_recreation', 'arts_and_entertainment'],
  community: ['community_and_government', 'education', 'cultural_and_historic'],
};
/** Left out of "All businesses": lakes, bridges, beaches and the like. */
export const NOT_A_BUSINESS_GROUPS: readonly string[] = ['geographic_entities'];

export const PLACES_ATTRIBUTION = '© Overture Maps Foundation';
export const PLACES_NOTE =
  'From Overture Maps, an open dataset built from several sources. Some businesses will be missing, closed or out of date; check before relying on a listing.';

/** Largest area that may be searched in one go, in square miles. */
export const MAX_AREA_SQ_MILES = 500;
export const MAX_VERTICES = 200;
/** Most businesses returned by one search. A dense city centre holds far more; the result then says it is partial. */
export const MAX_PLACES = 5000;

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

// ------------------------------------------------------------------ a result

export interface Place {
  id: string;
  name: string;
  category: Exclude<PlaceCategory, 'all'>;
  /** The specific kind in plain words, e.g. "Gas station". */
  kind: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  website: string;
  lon: number;
  lat: number;
}

export const DEFAULT_AREA_SEARCH_DAILY_CAP = 200;

/** Most area searches an organization may run in a day. */
export function readAreaSearchCap(settings: unknown): number {
  const v = ((settings ?? {}) as { areaSearchDailyCap?: unknown }).areaSearchDailyCap;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_AREA_SEARCH_DAILY_CAP;
}

// ------------------------------------------------------------------ directions

/**
 * A link that opens Google Maps with directions to a point, starting from wherever the
 * person is. This is a plain Maps URL: no API, no key and no charge. Format verified on
 * 2026-11-23: https://developers.google.com/maps/documentation/urls/get-started
 */
export function directionsUrl(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  // Six decimals is about four inches; the comma has to be sent as %2C.
  return `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)}%2C${lon.toFixed(6)}`;
}
