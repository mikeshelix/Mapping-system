/**
 * Businesses and points of interest from Overture Maps (free, open licence, no key).
 * Everything here is pure: reading the release catalog, choosing which data files a map
 * view needs, building the query and cleaning its rows. DuckDB itself runs in the web app.
 *
 * Verified against the live catalog on 2026-11-23 (release 2026-11-18.0, schema 2.0.0):
 *   https://stac.overturemaps.org/catalog.json                          -> "latest"
 *   https://stac.overturemaps.org/{release}/places/place/collection.json -> 16 item links
 *   each item                                                            -> bbox and assets.aws.href (HTTPS GeoParquet)
 * The places schema no longer has "categories"; the category is "basic_category".
 */
import { MAX_PLACES, NOT_A_BUSINESS_GROUPS, PLACE_CATEGORY_GROUPS, type LonLat, type Place, type PlaceCategory } from './places';

export interface Poi {
  id: string;
  name: string;
  /** Overture's category, e.g. "gas_station". Empty when it has none. */
  category: string;
  confidence: number;
  lon: number;
  lat: number;
  address: string;
  phone: string;
  website: string;
}

export interface ViewBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface PlacesFile {
  /** [west, south, east, north] of everything in the file. */
  bbox: [number, number, number, number];
  url: string;
}

/** Businesses are only loaded at this zoom or closer. */
export const POI_MIN_ZOOM = 13;
export const POI_LIMIT = 200;
export const POI_MIN_CONFIDENCE = 0.7;
/** Widest view, in degrees, the server will search. A zoom-13 map on a very wide screen is about 0.35 degrees across. */
export const POI_MAX_SPAN_DEG = 0.5;
export const POI_FILTER_MAX = 60;
export const POI_ATTRIBUTION = '© Overture Maps Foundation';
export const OVERTURE_CATALOG_URL = 'https://stac.overturemaps.org/catalog.json';

/** Address of the places collection for the newest release named in the root catalog, or null if the catalog is not as expected. */
export function latestPlacesCollection(catalog: unknown): { release: string; url: string } | null {
  const latest = (catalog as { latest?: unknown } | null)?.latest;
  if (typeof latest !== 'string' || !/^\d{4}-\d{2}-\d{2}\.\d{1,3}$/.test(latest)) return null;
  return { release: latest, url: `https://stac.overturemaps.org/${latest}/places/place/collection.json` };
}

/** Item addresses listed by a collection. Only addresses on the Overture catalog host are kept. */
export function placesItemUrls(collection: unknown): string[] {
  const links = (collection as { links?: unknown } | null)?.links;
  if (!Array.isArray(links)) return [];
  return links
    .filter((l): l is { rel: string; href: string } => !!l && typeof l === 'object' && (l as { rel?: unknown }).rel === 'item' && typeof (l as { href?: unknown }).href === 'string')
    .map((l) => l.href)
    .filter((href) => /^https:\/\/stac\.overturemaps\.org\/[\w.\-/]+\.json$/.test(href));
}

// The file address is written into the query text, so it must match this exactly: Overture's own bucket, a places file, no quotes.
const FILE_URL = /^https:\/\/overturemaps-us-west-2\.s3\.us-west-2\.amazonaws\.com\/release\/\d{4}-\d{2}-\d{2}\.\d{1,3}\/theme=places\/type=place\/[\w.\-]+\.parquet$/;

/** One data file from its catalog item, or null if anything about it is unexpected. */
export function placesFileFromItem(item: unknown): PlacesFile | null {
  const i = item as { bbox?: unknown; assets?: { aws?: { href?: unknown } } } | null;
  const url = i?.assets?.aws?.href;
  const bbox = i?.bbox;
  if (typeof url !== 'string' || !FILE_URL.test(url)) return null;
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null;
  return { bbox: bbox as [number, number, number, number], url };
}

/** Businesses Overture marks as permanently closed are never shown. */
const NOT_CLOSED = "(operating_status IS NULL OR operating_status <> 'permanently_closed')";

/** Reads "west,south,east,north". Returns why it cannot be used when it is not a sensible street-level view. */
export function parseViewBox(input: string | null): { ok: true; box: ViewBox } | { ok: false; error: string } {
  const parts = (input ?? '').split(',').map((p) => Number(p));
  const [west, south, east, north] = parts;
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return { ok: false, error: 'The map view is not valid.' };
  if (west! < -180 || east! > 180 || south! < -90 || north! > 90 || west! >= east! || south! >= north!) return { ok: false, error: 'The map view is not valid.' };
  if (east! - west! > POI_MAX_SPAN_DEG || north! - south! > POI_MAX_SPAN_DEG) return { ok: false, error: 'Zoom in to see businesses.' };
  return { ok: true, box: { west: west!, south: south!, east: east!, north: north! } };
}

/** The files whose contents can overlap the view. */
export function filesForView(files: PlacesFile[], box: ViewBox): PlacesFile[] {
  return files.filter((f) => f.bbox[0] <= box.east && f.bbox[2] >= box.west && f.bbox[1] <= box.north && f.bbox[3] >= box.south);
}

/** The filter as typed, trimmed and shortened; null when there is nothing to filter by. */
export function cleanPoiFilter(input: string | null): string | null {
  const text = (input ?? '').replace(/\s+/g, ' ').trim().slice(0, POI_FILTER_MAX);
  return text === '' ? null : text;
}

/** The value bound to the query's one parameter: the typed text as a "contains" pattern, with LIKE wildcards made literal. */
export function poiFilterPattern(filter: string): string {
  return `%${filter.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The DuckDB query for one view. Coordinates are numbers formatted here and file addresses
 * have been checked against FILE_URL; the only free text, the filter, is passed as parameter $1.
 */
export function buildPoiQuery(files: PlacesFile[], box: ViewBox, withFilter: boolean): string {
  const n = (v: number) => v.toFixed(6);
  const list = files.map((f) => `'${f.url}'`).join(', ');
  return `
SELECT id, names.primary AS name, basic_category AS category, confidence,
       ST_X(geometry) AS lon, ST_Y(geometry) AS lat,
       addresses[1].freeform AS address, addresses[1].locality AS city, addresses[1].region AS region, addresses[1].postcode AS postcode,
       phones[1] AS phone, websites[1] AS website
FROM read_parquet([${list}])
WHERE bbox.xmin BETWEEN ${n(box.west)} AND ${n(box.east)}
  AND bbox.ymin BETWEEN ${n(box.south)} AND ${n(box.north)}
  AND confidence > ${POI_MIN_CONFIDENCE}
  AND names.primary IS NOT NULL
  AND ${NOT_CLOSED}${
    withFilter
      ? `
  AND (names.primary ILIKE $1 ESCAPE '\\' OR replace(coalesce(basic_category, ''), '_', ' ') ILIKE $1 ESCAPE '\\')`
      : ''
  }
ORDER BY confidence DESC, id
LIMIT ${POI_LIMIT}`;
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** One query row as a business, or null when it has no name or no usable position. */
export function cleanPoiRow(row: Record<string, unknown>): Poi | null {
  const name = text(row.name, 160);
  const lon = Number(row.lon);
  const lat = Number(row.lat);
  if (!name || typeof row.id !== 'string' || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const website = text(row.website, 300);
  const region = text(row.region, 40).replace(/^US-/, '');
  return {
    id: row.id.slice(0, 80),
    name,
    category: text(row.category, 80),
    confidence: Math.round(Number(row.confidence) * 100) / 100 || 0,
    lon,
    lat,
    address: [text(row.address, 160), text(row.city, 80), [region, text(row.postcode, 12)].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    phone: text(row.phone, 30),
    // Only ordinary web links are passed on; anything else in the data is dropped.
    website: /^https?:\/\/[^\s"'<>]+$/i.test(website) ? website : '',
  };
}

/** "gas_station" -> "Gas station". */
export function poiCategoryLabel(category: string): string {
  const words = category.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Business';
}

// ------------------------------------------------------------------ businesses inside a shape

/** The smallest box around a ring. */
export function ringBounds(ring: LonLat[]): ViewBox {
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  return { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
}

/**
 * The DuckDB query for every business inside a ring. Nothing typed by a person reaches the
 * query text: the ring is formatted numbers, the category groups are fixed words from this
 * codebase, and file addresses have been checked. One row more than the limit is asked for,
 * so the caller can tell when the list is partial.
 */
export function buildAreaQuery(files: PlacesFile[], ring: LonLat[], category: PlaceCategory): string {
  const n = (v: number) => v.toFixed(6);
  const box = ringBounds(ring);
  const closed = [...ring, ring[0]!].map(([lon, lat]) => `${n(lon)} ${n(lat)}`).join(', ');
  const words = (list: readonly string[]) => list.filter((w) => /^[a-z_]+$/.test(w)).map((w) => `'${w}'`).join(', ');
  const group =
    category === 'all'
      ? `(taxonomy.hierarchy[1] IS NULL OR taxonomy.hierarchy[1] NOT IN (${words(NOT_A_BUSINESS_GROUPS)}))`
      : `taxonomy.hierarchy[1] IN (${words(PLACE_CATEGORY_GROUPS[category])})`;
  return `
SELECT id, names.primary AS name, basic_category AS kind, taxonomy.hierarchy[1] AS grp,
       ST_X(geometry) AS lon, ST_Y(geometry) AS lat,
       addresses[1].freeform AS address, addresses[1].locality AS city, addresses[1].region AS region, addresses[1].postcode AS postcode,
       phones[1] AS phone, websites[1] AS website
FROM read_parquet([${files.map((f) => `'${f.url}'`).join(', ')}])
WHERE bbox.xmin BETWEEN ${n(box.west)} AND ${n(box.east)}
  AND bbox.ymin BETWEEN ${n(box.south)} AND ${n(box.north)}
  AND confidence > ${POI_MIN_CONFIDENCE}
  AND names.primary IS NOT NULL
  AND ${NOT_CLOSED}
  AND ${group}
  AND ST_Contains(ST_GeomFromText('POLYGON((${closed}))'), geometry)
ORDER BY names.primary, id
LIMIT ${MAX_PLACES + 1}`;
}

const GROUP_TO_CATEGORY = new Map<string, Exclude<PlaceCategory, 'all'>>(
  (Object.entries(PLACE_CATEGORY_GROUPS) as Array<[Exclude<PlaceCategory, 'all'>, readonly string[]]>).flatMap(([category, groups]) => groups.map((g) => [g, category] as const)),
);

/** One area-query row as a business for the list and the download, or null when it has no name or position. */
export function cleanAreaRow(row: Record<string, unknown>): Place | null {
  const poi = cleanPoiRow({ ...row, category: row.kind, address: null, city: null, region: null, postcode: null });
  if (!poi) return null;
  return {
    id: poi.id,
    name: poi.name,
    // Places Overture has not grouped are filed under services, the broadest group.
    category: GROUP_TO_CATEGORY.get(text(row.grp, 60)) ?? 'services',
    kind: poi.category ? poiCategoryLabel(poi.category) : '',
    address: text(row.address, 160),
    city: text(row.city, 80),
    state: text(row.region, 40).replace(/^US-/, ''),
    zip: text(row.postcode, 12),
    phone: poi.phone,
    website: poi.website,
    lon: poi.lon,
    lat: poi.lat,
  };
}
