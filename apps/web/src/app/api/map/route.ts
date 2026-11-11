import { NextResponse } from 'next/server';
import { getSql } from '@hazard/db';
import { getUser } from '@/lib/auth';
import { isUuid } from '@/lib/form';

export const dynamic = 'force-dynamic';

/**
 * Everything the map needs for the signed-in organization: clients, properties,
 * and the active hazard events that touch at least one of its properties.
 * `?event=<id>` additionally includes that event even if it has ended
 * (used by the "view on the map" link in notifications).
 */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const focus = new URL(request.url).searchParams.get('event');
  const focusId = focus && isUuid(focus) ? focus : null;
  const sql = getSql();
  const org = user.organizationId;

  const [clients, properties, events] = await Promise.all([
    sql`SELECT id, name, color FROM clients WHERE organization_id = ${org} ORDER BY name`,
    sql`
      SELECT p.id, p.name, p.client_id, c.name AS client_name, c.color, p.property_type,
        concat_ws(', ', p.address, p.city, p.state, p.zip) AS address,
        ST_X(p.location) AS lon, ST_Y(p.location) AS lat
      FROM properties p JOIN clients c ON c.id = p.client_id WHERE p.organization_id = ${org}`,
    sql`
      SELECT e.id, e.event_name, e.hazard_type, e.severity, e.status, e.headline, e.area_desc, e.ends_at, e.source_url,
        array_agg(i.property_id::text) AS property_ids,
        ST_AsGeoJSON(ST_SimplifyPreserveTopology(
          COALESCE(e.geometry, (SELECT ST_Union(z.geometry) FROM geo_zones z WHERE z.code = ANY(e.zone_codes))), 0.002), 5) AS geometry
      FROM hazard_events e
      JOIN property_impacts i ON i.hazard_event_id = e.id AND i.organization_id = ${org}
      WHERE e.status = 'active' ${focusId ? sql`OR e.id = ${focusId}` : sql``}
      GROUP BY e.id
      ORDER BY e.severity DESC, count(*) DESC`,
  ]);

  const worst = new Map<string, { severity: string; rank: number }>();
  const RANK = ['unknown', 'minor', 'moderate', 'severe', 'extreme'];
  for (const e of events) {
    if (e.status !== 'active') continue;
    const rank = RANK.indexOf(e.severity);
    for (const pid of e.property_ids as string[]) {
      if ((worst.get(pid)?.rank ?? -1) < rank) worst.set(pid, { severity: e.severity, rank });
    }
  }

  return NextResponse.json({
    clients,
    properties: {
      type: 'FeatureCollection',
      features: properties.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: {
          id: p.id,
          name: p.name,
          clientId: p.client_id,
          clientName: p.client_name,
          color: p.color,
          address: p.address,
          propertyType: p.property_type,
          impact: worst.get(p.id)?.severity ?? 'none',
        },
      })),
    },
    events: events.map((e) => ({
      id: e.id,
      name: e.event_name,
      hazardType: e.hazard_type,
      severity: e.severity,
      status: e.status,
      headline: e.headline,
      area: e.area_desc,
      endsAt: e.ends_at,
      sourceUrl: e.source_url,
      propertyIds: e.property_ids,
    })),
    hazards: {
      type: 'FeatureCollection',
      features: events
        .filter((e) => e.geometry)
        .map((e) => ({
          type: 'Feature',
          geometry: JSON.parse(e.geometry),
          properties: { id: e.id, name: e.event_name, severity: e.severity },
        })),
    },
  });
}
