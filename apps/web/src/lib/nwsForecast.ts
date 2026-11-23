/**
 * Fetches a National Weather Service forecast for one point, with two small caches so
 * the service is asked as rarely as its own cache headers suggest: which forecast grid a
 * point falls in (a day), and that grid's forecast (half an hour). Locations close
 * together share a grid, so a large portfolio needs far fewer requests than it has locations.
 */
import { forecastUrlFromPoint, parseForecast, type ForecastPeriod } from '@hazard/core';

export type ForecastResult =
  | { status: 'ok'; periods: ForecastPeriod[]; fetchedAt: string }
  /** The Weather Service only covers the United States and its territories. */
  | { status: 'outside' }
  | { status: 'unavailable' };

interface Entry<T> {
  at: number;
  value: T;
}
const key = Symbol.for('hazard.web.forecastCache');
const store = globalThis as typeof globalThis & { [key]?: { grids: Map<string, Entry<string | null>>; forecasts: Map<string, Entry<{ periods: ForecastPeriod[]; fetchedAt: string }>> } };
const caches = () => (store[key] ??= { grids: new Map(), forecasts: new Map() });

const GRID_TTL_MS = 24 * 3_600_000;
const FORECAST_TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 20_000;

function remember<T>(map: Map<string, Entry<T>>, k: string, value: T): void {
  // Oldest entries go first once the cache is full.
  if (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value as string);
  map.set(k, { at: Date.now(), value });
}

const userAgent = () => process.env.NWS_USER_AGENT || 'HelixcoWeatherApp/1.0';

async function getJson(url: string, fetchImpl: typeof fetch): Promise<{ status: number; json: unknown }> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': userAgent(), Accept: 'application/geo+json' },
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  });
  return { status: res.status, json: res.ok ? await res.json() : null };
}

export async function forecastFor(lat: number, lon: number, fetchImpl: typeof fetch = fetch): Promise<ForecastResult> {
  const { grids, forecasts } = caches();
  // Four decimals is about 35 feet, the precision the service itself redirects to.
  const point = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  try {
    let grid = grids.get(point);
    if (!grid || Date.now() - grid.at > GRID_TTL_MS) {
      const reply = await getJson(`https://api.weather.gov/points/${point}`, fetchImpl);
      if (reply.status !== 200 && reply.status !== 404) return { status: 'unavailable' };
      remember(grids, point, reply.status === 404 ? null : forecastUrlFromPoint(reply.json));
      grid = grids.get(point)!;
    }
    if (!grid.value) return { status: 'outside' };
    const cached = forecasts.get(grid.value);
    if (cached && Date.now() - cached.at <= FORECAST_TTL_MS) return { status: 'ok', ...cached.value };
    const reply = await getJson(grid.value, fetchImpl);
    const periods = reply.status === 200 ? parseForecast(reply.json) : [];
    // The service sometimes answers 500 or 503 for a grid for a while; an older forecast beats none.
    if (periods.length === 0) return cached ? { status: 'ok', ...cached.value } : { status: 'unavailable' };
    const value = { periods, fetchedAt: new Date().toISOString() };
    remember(forecasts, grid.value, value);
    return { status: 'ok', ...value };
  } catch {
    return { status: 'unavailable' };
  }
}

/** For tests. */
export function clearForecastCache(): void {
  delete store[key];
}
