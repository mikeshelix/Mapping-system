import { NextResponse } from 'next/server';
import { MAX_AREA_SQ_MILES, checkShape } from '@hazard/core';
import { alertSearchArea, getSql } from '@hazard/db';
import { getUser } from '@/lib/auth';
import { isUuid } from '@/lib/form';

export const dynamic = 'force-dynamic';

/**
 * The part of one alert that is on screen, as an outline the business search can take.
 * ?view=west,south,east,north is the map's current view.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const view = (new URL(request.url).searchParams.get('view') ?? '').split(',').map(Number);
  const [west, south, east, north] = view;
  if (view.length !== 4 || view.some((n) => !Number.isFinite(n)) || west! >= east! || south! >= north!) {
    return NextResponse.json({ error: 'The map view is not valid.' }, { status: 400 });
  }
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  const area = await alertSearchArea(getSql(), id, { west: clamp(west!, -180, 180), south: clamp(south!, -90, 90), east: clamp(east!, -180, 180), north: clamp(north!, -90, 90) });
  if (!area) return NextResponse.json({ error: 'That alert was not found. It may have ended.' }, { status: 404 });
  if (!area.ring) return NextResponse.json({ error: `None of "${area.name}" is on screen. Move the map to it and try again.` }, { status: 422 });
  const sqMiles = Math.round(area.areaSqMiles);
  if (area.areaSqMiles > MAX_AREA_SQ_MILES) {
    return NextResponse.json(
      { error: `The part of "${area.name}" on screen covers about ${sqMiles.toLocaleString('en-US')} square miles. A search can cover ${MAX_AREA_SQ_MILES}. Zoom in to the part you want and press the button again.` },
      { status: 422 },
    );
  }
  const shape = checkShape(area.ring);
  if (!shape.ok) return NextResponse.json({ error: `"${area.name}" has a shape that cannot be searched. Draw the area by hand instead.` }, { status: 422 });
  return NextResponse.json({ name: area.name, ring: shape.ring, areaSqMiles: Math.round(shape.areaSqMiles * 100) / 100, pieces: area.pieces });
}
