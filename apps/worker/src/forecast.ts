/**
 * Forecast heads-ups. For every location covered by a rule that asks for them, read the
 * National Weather Service forecast and email contacts when it first shows weather worth
 * watching in the next two days. Locations close together share one forecast request,
 * and when no rule asks for heads-ups nothing is fetched at all.
 */
import { flaggedPeriods, forecastUrlFromPoint, parseForecast, type FlaggedPeriod } from '@hazard/core';
import { getForecastGrids, loadForecastWork, queueForecastHeadsUps, saveForecastGrid, type Sql } from '@hazard/db';
import { fetchWithRetry, log } from './util';

const headers = () => ({ 'User-Agent': process.env.NWS_USER_AGENT || 'HelixcoWeatherApp/1.0', Accept: 'application/geo+json' });
/** New locations whose grid is looked up in one run; the rest wait for the next, to stay polite to the service. */
const MAX_NEW_POINTS_PER_RUN = 2000;
const PAUSE_MS = 150;
const pause = () => new Promise((resolve) => setTimeout(resolve, PAUSE_MS));

export async function runForecastHeadsUps(sql: Sql, opts: { appBaseUrl: string }): Promise<void> {
  const work = await loadForecastWork(sql);
  if (work.properties.length === 0) return;

  // 1. Which forecast grid each location is in (looked up once, then remembered).
  const pointOf = (p: { lat: number; lon: number }) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
  const grids = await getForecastGrids(sql, [...new Set(work.properties.map(pointOf))]);
  let lookedUp = 0;
  for (const point of new Set(work.properties.map(pointOf))) {
    if (grids.has(point) || lookedUp >= MAX_NEW_POINTS_PER_RUN) continue;
    lookedUp++;
    try {
      const res = await fetchWithRetry(`https://api.weather.gov/points/${point}`, { headers: headers() }, { timeoutMs: 20_000 });
      // 404 means the point is outside the area the Weather Service forecasts for.
      if (res.status !== 200 && res.status !== 404) continue;
      const url = res.status === 200 ? forecastUrlFromPoint(await res.json()) : null;
      await saveForecastGrid(sql, point, url);
      grids.set(point, url);
    } catch {
      // Left unknown; tried again next run.
    }
    await pause();
  }

  // 2. One forecast per grid.
  const now = new Date();
  const byGrid = new Map<string, FlaggedPeriod[] | null>();
  let failed = 0;
  for (const url of new Set([...grids.values()].filter((u): u is string => !!u))) {
    try {
      const res = await fetchWithRetry(url, { headers: headers() }, { timeoutMs: 20_000 });
      byGrid.set(url, res.ok ? flaggedPeriods(parseForecast(await res.json(), 14), now) : null);
      if (!res.ok) failed++;
    } catch {
      byGrid.set(url, null);
      failed++;
    }
    await pause();
  }

  // 3. Tell contacts about anything new.
  const flaggedByProperty = new Map<string, FlaggedPeriod[]>();
  for (const p of work.properties) {
    const url = grids.get(pointOf(p));
    const flagged = url ? byGrid.get(url) : null;
    if (flagged?.length) flaggedByProperty.set(p.id, flagged);
  }
  const queued = await queueForecastHeadsUps(sql, work, flaggedByProperty, opts);
  log('info', 'forecast heads-ups', { locations: work.properties.length, grids: byGrid.size, gridsFailed: failed, flaggedLocations: flaggedByProperty.size, queued });
}
