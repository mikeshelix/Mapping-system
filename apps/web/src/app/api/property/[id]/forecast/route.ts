import { NextResponse } from 'next/server';
import { FORECAST_SOURCE } from '@hazard/core';
import { getSql, propertyPoint } from '@hazard/db';
import { getUser } from '@/lib/auth';
import { isUuid } from '@/lib/form';
import { forecastFor } from '@/lib/nwsForecast';

export const dynamic = 'force-dynamic';

/** The next three days of weather at one of the organization's locations, from the National Weather Service. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const point = await propertyPoint(getSql(), user.organizationId, id);
  if (!point) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ...(await forecastFor(point.lat, point.lon)), source: FORECAST_SOURCE });
}
