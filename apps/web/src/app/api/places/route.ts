import { NextResponse } from 'next/server';
import { PLACES_ATTRIBUTION, PLACE_CATEGORIES, checkShape, readAreaSearchCap, ringToPolygon, type PlaceCategory } from '@hazard/core';
import { areaSearchesToday, getSql, propertiesInArea, recordAreaSearch } from '@hazard/db';
import { getUser } from '@/lib/auth';
import { findPlacesInArea } from '@/lib/overture';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Businesses inside a drawn area or an alert's outline, from Overture Maps (free, open
 * data, no key), read in place with DuckDB. See lib/overture.ts.
 */
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
    recordAreaSearch(sql, { organizationId: user.organizationId, userId: user.id, polygon, category, source: 'overture', resultCount, status, error, durationMs: Date.now() - started });

  try {
    const [found, own] = await Promise.all([findPlacesInArea(shape.ring, category), propertiesInArea(sql, user.organizationId, polygon)]);
    await log('ok', found.places.length);
    return NextResponse.json({
      places: found.places,
      ownProperties: own,
      areaSqMiles: Math.round(shape.areaSqMiles * 100) / 100,
      truncated: found.truncated,
      attribution: PLACES_ATTRIBUTION,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[places]', detail);
    await log('error', 0, detail).catch(() => {});
    return NextResponse.json({ error: 'The business search could not be completed just now. Please try again in a moment.' }, { status: 502 });
  }
}
