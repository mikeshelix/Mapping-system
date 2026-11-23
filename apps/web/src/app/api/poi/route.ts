import { NextResponse } from 'next/server';
import { POI_ATTRIBUTION, cleanPoiFilter, parseViewBox } from '@hazard/core';
import { getUser } from '@/lib/auth';
import { findPois } from '@/lib/overture';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Businesses in the current map view, from Overture Maps (free, open data).
 * ?view=west,south,east,north and optionally &q= to filter by name or category.
 */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const view = parseViewBox(params.get('view'));
  if (!view.ok) return NextResponse.json({ error: view.error }, { status: 400 });
  try {
    const found = await findPois(view.box, cleanPoiFilter(params.get('q')));
    return NextResponse.json({ ...found, attribution: POI_ATTRIBUTION });
  } catch (error) {
    console.error('[poi]', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'Businesses could not be loaded just now. Move the map or try again in a moment.' }, { status: 502 });
  }
}
