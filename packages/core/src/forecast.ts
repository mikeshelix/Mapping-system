/**
 * National Weather Service point forecasts (free, no key, United States only).
 * Verified against the live service on 2026-11-23:
 *   GET https://api.weather.gov/points/{lat},{lon}      -> properties.forecast (a gridpoint URL), cacheable for a day
 *   GET https://api.weather.gov/gridpoints/{office}/{x},{y}/forecast -> properties.periods (14 half-days), cacheable for an hour
 * Everything here is pure; the fetching lives in the web app.
 */

export interface ForecastPeriod {
  /** "Today", "Tonight", "Tuesday", ... as the Weather Service names it. */
  name: string;
  startTime: string;
  endTime: string;
  isDaytime: boolean;
  temperature: number | null;
  temperatureUnit: string;
  /** Chance of rain or snow, percent. Null when the forecast gives none. */
  precipChance: number | null;
  wind: string;
  shortForecast: string;
  detailedForecast: string;
  /** Plain-word reasons this period deserves attention, most serious first. Empty for ordinary weather. */
  concerns: string[];
}

export const FORECAST_SOURCE = 'National Weather Service';
export const FORECAST_PERIODS_SHOWN = 6;

/** Sustained wind, mph, at or above which a period is flagged. */
export const FORECAST_WIND_MPH = 30;
/** Gusts, mph, at or above which a period is flagged. */
export const FORECAST_GUST_MPH = 40;

/** The forecast address inside a /points reply, or null if it is missing or points anywhere but the Weather Service. */
export function forecastUrlFromPoint(json: unknown): string | null {
  const url = (json as { properties?: { forecast?: unknown } } | null)?.properties?.forecast;
  return typeof url === 'string' && /^https:\/\/api\.weather\.gov\/gridpoints\/[A-Z]{3,4}\/\d{1,3},\d{1,3}\/forecast$/.test(url) ? url : null;
}

const highest = (text: string, pattern: RegExp): number => {
  let max = 0;
  for (const m of text.matchAll(pattern)) max = Math.max(max, Number(m[1]));
  return max;
};

/**
 * Why a forecast period is worth a second look. This reads the forecaster's own words and
 * wind figures; it is a prompt to look closer, not a warning. Official warnings arrive
 * separately as alerts.
 */
export function forecastConcerns(p: { shortForecast: string; detailedForecast: string; wind: string }): string[] {
  const text = `${p.shortForecast}. ${p.detailedForecast}`.toLowerCase();
  const found: string[] = [];
  if (/\b(tornado|hurricane|tropical storm|blizzard|ice storm)/.test(text)) found.push('Severe weather possible');
  if (/thunderstorm/.test(text)) found.push('Thunderstorms');
  if (/\b(freezing rain|freezing drizzle|sleet|ice accumulation|wintry mix)/.test(text)) found.push('Ice');
  if (/\bsnow/.test(text) && !/\bsnow level/.test(text)) found.push('Snow');
  if (/\bheavy rain|rain[^.]*\bheavy\b|heavy at times/.test(text)) found.push('Heavy rain');
  // "10 to 20 mph" counts as 20. Gusts are only stated in the detailed text.
  const sustained = highest(p.wind.toLowerCase(), /(\d{1,3})\s*mph/g);
  const gusts = highest(text, /gusts? as high as (\d{1,3})\s*mph/g);
  if (sustained >= FORECAST_WIND_MPH || gusts >= FORECAST_GUST_MPH) found.push('Strong wind');
  return found;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The first few periods of a gridpoint forecast reply. Malformed periods are skipped. */
export function parseForecast(json: unknown, limit = FORECAST_PERIODS_SHOWN): ForecastPeriod[] {
  const periods = (json as { properties?: { periods?: unknown } } | null)?.properties?.periods;
  if (!Array.isArray(periods)) return [];
  const out: ForecastPeriod[] = [];
  for (const raw of periods) {
    if (out.length >= limit) break;
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const name = str(r.name, 40);
    const shortForecast = str(r.shortForecast, 120);
    if (!name || !shortForecast || typeof r.startTime !== 'string' || typeof r.endTime !== 'string') continue;
    const chance = (r.probabilityOfPrecipitation as { value?: unknown } | null)?.value;
    const base = { shortForecast, detailedForecast: str(r.detailedForecast, 600), wind: [str(r.windDirection, 5), str(r.windSpeed, 30)].filter(Boolean).join(' ') };
    out.push({
      name,
      startTime: r.startTime,
      endTime: r.endTime,
      isDaytime: r.isDaytime === true,
      temperature: typeof r.temperature === 'number' && Number.isFinite(r.temperature) ? r.temperature : null,
      temperatureUnit: str(r.temperatureUnit, 2) || 'F',
      precipChance: typeof chance === 'number' && Number.isFinite(chance) ? Math.round(chance) : null,
      ...base,
      concerns: forecastConcerns(base),
    });
  }
  return out;
}

/** How far ahead a heads-up looks. */
export const HEADS_UP_HOURS = 48;

export interface FlaggedPeriod {
  /** Local calendar day the period starts on, YYYY-MM-DD. */
  day: string;
  /** "Wednesday Night" */
  name: string;
  shortForecast: string;
  concerns: string[];
}

/** The periods with something worth watching that start within the look-ahead window and have not ended. */
export function flaggedPeriods(periods: ForecastPeriod[], now: Date, hours = HEADS_UP_HOURS): FlaggedPeriod[] {
  const from = now.getTime();
  const until = from + hours * 3_600_000;
  const out: FlaggedPeriod[] = [];
  for (const p of periods) {
    const start = Date.parse(p.startTime);
    const end = Date.parse(p.endTime);
    if (p.concerns.length === 0 || !Number.isFinite(start) || !Number.isFinite(end) || end <= from || start > until) continue;
    // The timestamp carries the location's own UTC offset, so its date part is the local day.
    const day = p.startTime.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    out.push({ day, name: p.name, shortForecast: p.shortForecast, concerns: p.concerns });
  }
  return out;
}
