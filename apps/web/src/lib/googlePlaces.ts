/**
 * Google Maps Platform "Maps Experience agent tools" (formerly Grounding Lite): place search.
 * Endpoint, fields and limits were verified against the live service and its documentation
 * on 2026-11-23: https://developers.google.com/maps/ai/grounding-lite
 *
 * Requests stay on the Essentials tier (at most five places, no extended details), which
 * has 10,000 no-charge requests a month. Results are passed to the assistant and shown to
 * the person who asked; nothing Google returns is stored.
 */
import { PLACES_RESULT_MAX, type PlaceSource } from '@hazard/core';

const ENDPOINT = 'https://mapstools.googleapis.com/v1:searchText';
const TIMEOUT_MS = 20_000;
/** Google accepts a bias circle of at most 50 km. */
const BIAS_RADIUS_M = 25_000;

export const googlePlacesEnabled = () => !!process.env.GOOGLE_MAPS_API_KEY?.trim();

export interface PlacesAnswer {
  /** Google's written summary. "[0]"-style marks refer to entries in places. */
  summary: string;
  places: Array<{ name: string; latitude: number | null; longitude: number | null }>;
  sources: PlaceSource[];
}

const isGoogleMapsUrl = (u: unknown): u is string => {
  if (typeof u !== 'string') return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && /(^|\.)google\.com$/.test(url.hostname);
  } catch {
    return false;
  }
};

/** Turn Google's response into what the assistant and the page need. Exported for tests. */
export function readPlacesResponse(json: unknown): PlacesAnswer {
  const body = (json && typeof json === 'object' ? json : {}) as { summary?: unknown; places?: unknown };
  const places: PlacesAnswer['places'] = [];
  const sources: PlaceSource[] = [];
  for (const raw of Array.isArray(body.places) ? body.places.slice(0, PLACES_RESULT_MAX) : []) {
    const p = raw as { location?: { latitude?: unknown; longitude?: unknown }; attribution?: { title?: unknown; url?: unknown }; googleMapsLinks?: { placeUrl?: unknown } };
    const title = typeof p.attribution?.title === 'string' ? p.attribution.title.trim().slice(0, 200) : '';
    const url = isGoogleMapsUrl(p.attribution?.url) ? p.attribution.url : isGoogleMapsUrl(p.googleMapsLinks?.placeUrl) ? p.googleMapsLinks.placeUrl : null;
    // A place that cannot be attributed to Google Maps with a link cannot be shown at all.
    if (!title || !url) continue;
    const lat = Number(p.location?.latitude);
    const lon = Number(p.location?.longitude);
    places.push({
      name: title.replace(/\s+-\s+Google Maps$/, ''),
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lon) ? lon : null,
    });
    sources.push({ title, url });
  }
  return { summary: typeof body.summary === 'string' ? body.summary.slice(0, 6000) : '', places, sources };
}

export class GooglePlacesError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export async function searchGooglePlaces(
  query: string,
  center: { lat: number; lon: number } | null,
  fetchImpl: typeof fetch = fetch,
): Promise<PlacesAnswer> {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) throw new GooglePlacesError('GOOGLE_MAPS_API_KEY is not set', null);
  let res: Response;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      // The key travels in a header, never in the URL, so it cannot end up in a log line.
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
      body: JSON.stringify({
        textQuery: query,
        pageSize: PLACES_RESULT_MAX,
        languageCode: 'en',
        regionCode: 'US',
        ...(center ? { locationBias: { circle: { center: { latitude: center.lat, longitude: center.lon }, radiusMeters: BIAS_RADIUS_M } } } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new GooglePlacesError(`Google place search could not be reached: ${error instanceof Error ? error.name : 'error'}`, null);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).replaceAll(key, '[key]').slice(0, 300);
    throw new GooglePlacesError(`Google place search returned HTTP ${res.status}: ${detail}`, res.status);
  }
  return readPlacesResponse(await res.json());
}
