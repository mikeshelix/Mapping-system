import { NextResponse } from 'next/server';
import {
  MAX_PLACES,
  PLACES_ATTRIBUTION,
  PLACE_CATEGORIES,
  buildOverpassQuery,
  checkShape,
  parseOverpass,
  readAreaSearchCap,
  ringToPolygon,
  type PlaceCategory,
} from '@hazard/core';
import { areaSearchesToday, getSql, propertiesInArea, recordAreaSearch } from '@hazard/db';
import { getUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 150;

/**
 * Businesses inside a drawn area, from OpenStreetMap via the Overpass API (free, no key).
 * Point OVERPASS_URL at your own Overpass server if use outgrows the public one
 * (its guideline is about 10,000 requests a day in total).
 */
const overpassUrl = () => process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const userAgent = () => process.env.PLACES_USER_AGENT || process.env.NWS_USER_AGENT || 'HelixcoWeatherApp/1.0';

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { ring?: unknown; category?: unknown } | null;
  const shape = checkShape(body?.ring);
  if (!shape.ok) return NextResponse.json({ error: shape.error }, { status: 400 });
  const category: PlaceCategory = (PLACE_CATEGORIES as readonly string[]).includes(body?.category as string) ? (body!.category as PlaceCategory) : 'all';

  const sql = getSql();
  const [[org], today] = await Promise.all([sql`SELECT settings FROM organizations WHERE id = ${user.organizationId}`, areaSearchesToday(sql, user.organizationId)]);
  const cap = readAreaSearchCap(org?.settings);
  if (today >= cap) return NextResponse.json({ error: `Your organization has reached today's limit of ${cap} area searches.` }, { status: 429 });

  const polygon = ringToPolygon(shape.ring);
  const started = Date.now();
  const log = (status: 'ok' | 'error', resultCount: number, error?: string) =>
    recordAreaSearch(sql, { organizationId: user.organizationId, userId: user.id, polygon, category, source: 'osm-overpass', resultCount, status, error, durationMs: Date.now() - started });

  try {
    const query = buildOverpassQuery(shape.ring, category);
    const ask = () =>
      fetch(overpassUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent(), Accept: 'application/json' },
        body: new URLSearchParams({ data: query }),
        // The public server can take over half a minute when it is busy.
        signal: AbortSignal.timeout(60_000),
        cache: 'no-store',
      });
    const overloaded = (status: number) => [429, 502, 503, 504].includes(status);
    const lookup = async () => {
      const first = await ask();
      if (!overloaded(first.status)) return first;
      // The public server sheds load with these codes; one polite retry usually gets through.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      return ask();
    };
    const [res, own] = await Promise.all([lookup(), propertiesInArea(sql, user.organizationId, polygon)]);
    if (!res.ok) {
      await log('error', 0, `HTTP ${res.status}`);
      const busy = overloaded(res.status);
      return NextResponse.json(
        { error: busy ? 'The business data service is busy. Wait a minute and try again, or draw a smaller area.' : 'The business data service returned an error. Please try again.' },
        { status: 502 },
      );
    }
    const reply = (await res.json()) as { remark?: string };
    const places = parseOverpass(reply, category);
    // Overpass reports a query that ran out of time or memory as a remark on an otherwise normal reply.
    const partial = typeof reply.remark === 'string' && /timed out|out of memory/i.test(reply.remark);
    await log('ok', places.length);
    return NextResponse.json({
      places,
      ownProperties: own,
      areaSqMiles: Math.round(shape.areaSqMiles * 100) / 100,
      truncated: partial || places.length >= MAX_PLACES,
      attribution: PLACES_ATTRIBUTION,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[places]', detail);
    await log('error', 0, detail).catch(() => {});
    return NextResponse.json({ error: 'The business data service could not be reached. Please try again.' }, { status: 502 });
  }
}
