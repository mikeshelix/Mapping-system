import { NextResponse } from 'next/server';
import { patternOf } from '@hazard/core';
import { getSql } from '@hazard/db';
import { getUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

interface Cached {
  at: number;
  body: string;
}
const key = Symbol.for('hazard.web.weatherCache');
const store = globalThis as typeof globalThis & { [key]?: Cached; };
const MAX_AGE_MS = 60_000;

/**
 * Every active hazard nationwide, as shapes, for the "Everywhere" view of the map.
 * The same for every organization (it is public government data), so it is built
 * once a minute and shared. Marine alerts are left out: they cover open water.
 */
export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const cached = store[key];
  if (!cached || Date.now() - cached.at > MAX_AGE_MS) {
    const rows = await getSql()`
      SELECT e.id, e.source, e.event_name, e.hazard_type, e.severity, e.headline, e.ends_at,
        ST_AsGeoJSON(ST_SimplifyPreserveTopology(
          COALESCE(e.geometry, (SELECT ST_Union(z.geometry) FROM geo_zones z WHERE z.code = ANY(e.zone_codes))), 0.01), 3) AS geometry
      FROM hazard_events e
      WHERE e.status = 'active' AND e.hazard_type <> 'marine'
      ORDER BY e.severity, e.first_seen_at DESC LIMIT 5000`;
    store[key] = {
      at: Date.now(),
      body: JSON.stringify({
        type: 'FeatureCollection',
        features: rows
          .filter((e) => e.geometry)
          .map((e) => ({
            type: 'Feature',
            geometry: JSON.parse(e.geometry),
            properties: {
              id: e.id,
              name: e.event_name,
              severity: e.severity,
              source: e.source,
              hazardType: e.hazard_type,
              pattern: patternOf(e.hazard_type),
              headline: e.headline ? String(e.headline).slice(0, 240) : null,
              endsAt: e.ends_at,
            },
          })),
      }),
    };
  }
  return new Response(store[key]!.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
