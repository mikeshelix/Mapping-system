/**
 * National Weather Service alerts feed.
 * Docs: https://www.weather.gov/documentation/services-web-api
 *  - A User-Agent identifying the application is required (requests without one get 403).
 *  - NWS asks clients not to poll more often than every 30 seconds.
 *  - Most alerts have no polygon; their area is the list of forecast zones / counties,
 *    whose polygons are fetched once from /zones/... and cached in geo_zones.
 */
import { normalizeNwsAlert, type GeoJsonGeometry, type NormalizedAlert, type NwsAlertFeature } from '@hazard/core';
import { expireMissing, finishRun, ingestAlert, startRun, upsertZone, type Sql } from '@hazard/db';
import { errorMessage, fetchWithRetry, HttpError, log, sleep } from './util';

export const NWS_FEED = 'nws';
const ACTIVE_URL = 'https://api.weather.gov/alerts/active?status=actual';
const ZONE_URL_PREFIX = 'https://api.weather.gov/zones/';

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'User-Agent': process.env.NWS_USER_AGENT || 'HelixcoWeatherApp/1.0',
    Accept: 'application/geo+json',
    ...extra,
  };
}

// Conditional-request cache: the last ETag and what it described.
let cachedEtag: string | null = null;

interface AlertsPage {
  features?: NwsAlertFeature[];
  pagination?: { next?: string };
}

export async function pollNwsAlerts(sql: Sql): Promise<void> {
  const runId = await startRun(sql, NWS_FEED);
  try {
    const res = await fetchWithRetry(ACTIVE_URL, { headers: headers(cachedEtag ? { 'If-None-Match': cachedEtag } : {}) });
    if (res.status === 304) {
      await finishRun(sql, NWS_FEED, runId, { status: 'not_modified', httpStatus: 304 });
      return;
    }
    if (!res.ok) throw new HttpError(res.status, ACTIVE_URL);
    const etag = res.headers.get('etag');

    const features: NwsAlertFeature[] = [];
    let page = (await res.json()) as AlertsPage;
    features.push(...(page.features ?? []));
    for (let i = 0; page.pagination?.next && i < 20; i++) {
      const next = await fetchWithRetry(page.pagination.next, { headers: headers() });
      if (!next.ok) throw new HttpError(next.status, page.pagination.next);
      page = (await next.json()) as AlertsPage;
      features.push(...(page.features ?? []));
    }

    const alerts = features
      .map((f) => normalizeNwsAlert(f))
      .filter((a): a is NormalizedAlert => a !== null)
      // Oldest first, so a chain of updates received in one poll applies in order.
      .sort((a, b) => Date.parse(a.sentAt ?? '') - Date.parse(b.sentAt ?? ''));

    const counts = { new: 0, updated: 0, cancelled: 0, failed: 0 };
    for (const alert of alerts) {
      try {
        const { decision } = await ingestAlert(sql, alert);
        if (decision.action === 'create') counts.new++;
        else if (decision.action === 'update') counts.updated++;
        else if (decision.action === 'cancel') counts.cancelled++;
      } catch (err) {
        // One malformed alert must not stop the rest of the feed.
        counts.failed++;
        log('error', 'nws alert ingest failed', { messageId: alert.messageId, error: errorMessage(err) });
      }
    }

    // An empty national feed is far more likely a bad response than calm weather everywhere,
    // so only expire events when the feed has content.
    const expired = alerts.length > 0 ? await expireMissing(sql, NWS_FEED, alerts.map((a) => a.messageId)) : 0;

    cachedEtag = etag;
    await finishRun(sql, NWS_FEED, runId, {
      status: 'ok',
      httpStatus: res.status,
      eventsSeen: alerts.length,
      eventsNew: counts.new,
      eventsUpdated: counts.updated,
      eventsCancelled: counts.cancelled,
      eventsExpired: expired,
      error: counts.failed ? `${counts.failed} alert(s) failed to ingest` : null,
      etag,
    });
    if (counts.new || counts.updated || counts.cancelled || expired) {
      log('info', 'nws poll', { seen: alerts.length, ...counts, expired });
    }
  } catch (err) {
    await finishRun(sql, NWS_FEED, runId, {
      status: 'error',
      httpStatus: err instanceof HttpError ? err.status : null,
      error: errorMessage(err),
    });
    throw err;
  }
}

interface ZoneResponse {
  geometry?: GeoJsonGeometry | null;
  properties?: { id?: string; type?: string; name?: string; state?: string };
}

/**
 * Fetch polygons for zones that active events need and we have not cached yet.
 * Bounded per run and spaced out to stay well within NWS rate limits.
 */
export async function fetchMissingZones(sql: Sql, maxPerRun = 40): Promise<number> {
  // NWS alerts name the URL of each zone. Other sources (FEMA) only give a county code,
  // whose URL follows from the code: two-letter state, "C", three-digit county FIPS.
  const rows = await sql`
    SELECT DISTINCT ON (c.code) COALESCE(
      (SELECT u.url FROM jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(e.raw->'properties'->'affectedZones') = 'array' THEN e.raw->'properties'->'affectedZones' ELSE '[]'::jsonb END) AS u(url)
       WHERE split_part(u.url, '/', -1) = c.code LIMIT 1),
      CASE WHEN c.code ~ '^[A-Z]{2}C[0-9]{3}$' THEN ${ZONE_URL_PREFIX} || 'county/' || c.code
           WHEN c.code ~ '^[A-Z]{2}Z[0-9]{3}$' THEN ${ZONE_URL_PREFIX} || 'forecast/' || c.code END) AS url
    FROM hazard_events e, unnest(e.zone_codes) AS c(code)
    WHERE e.status = 'active' AND e.zones_pending
      AND NOT EXISTS (SELECT 1 FROM geo_zones z WHERE z.code = c.code)
    LIMIT ${maxPerRun}`;

  let fetched = 0;
  for (const { url } of rows as unknown as Array<{ url: string }>) {
    if (!url || !url.startsWith(ZONE_URL_PREFIX)) continue;
    const parts = url.split('/');
    const code = parts.at(-1)!;
    const kind = parts.at(-2) ?? 'forecast';
    try {
      const res = await fetchWithRetry(url, { headers: headers() });
      if (res.status === 404) {
        // Record the miss so one retired zone cannot keep events pending forever.
        await upsertZone(sql, { code, kind, name: null, state: null, geometry: null, error: 'HTTP 404' });
      } else if (!res.ok) {
        throw new HttpError(res.status, url);
      } else {
        const zone = (await res.json()) as ZoneResponse;
        await upsertZone(sql, {
          code,
          kind,
          name: zone.properties?.name ?? null,
          state: zone.properties?.state ?? null,
          geometry: zone.geometry ?? null,
          error: zone.geometry ? undefined : 'no geometry',
        });
        fetched++;
      }
    } catch (err) {
      // Left uncached; picked up again on the next run.
      log('warn', 'zone fetch failed', { code, error: errorMessage(err) });
    }
    await sleep(150);
  }
  if (fetched) log('info', 'zones cached', { fetched });
  return fetched;
}
