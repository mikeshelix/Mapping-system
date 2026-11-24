import type { ProspectInput, ProspectSource, ProspectStatus } from '@hazard/core';
import type { Sql } from './client';

export interface AddResult {
  /** New on the list. */
  added: number;
  /** Already on the list, left as they were. */
  already: number;
}

/** Adds businesses to an organization's prospect list. One already on the list (same map id) is left untouched. */
export async function addProspects(
  sql: Sql,
  organizationId: string,
  userId: string | null,
  items: ProspectInput[],
  source: Exclude<ProspectSource, 'property'>,
  foundIn: string,
): Promise<AddResult> {
  if (items.length === 0) return { added: 0, already: 0 };
  // Two entries with the same map id in one request would otherwise collide with each other.
  const seen = new Set<string>();
  const rows = items
    .filter((p) => {
      if (!p.sourceRef) return true;
      if (seen.has(p.sourceRef)) return false;
      seen.add(p.sourceRef);
      return true;
    })
    .map((p) => ({
      organization_id: organizationId,
      name: p.name,
      kind: p.kind,
      address: p.address,
      city: p.city,
      state: p.state,
      zip: p.zip,
      phone: p.phone,
      website: p.website,
      lon: p.lon,
      lat: p.lat,
      source,
      source_ref: source === 'manual' ? null : p.sourceRef,
      found_in: foundIn,
      created_by: userId,
    }));
  const inserted = await sql`
    INSERT INTO prospects ${sql(rows)}
    ON CONFLICT (organization_id, source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING
    RETURNING id`;
  return { added: inserted.length, already: items.length - inserted.length };
}

/** Adds the organization's own locations to its prospect list, read from the database rather than trusted from the browser. */
export async function addPropertyProspects(sql: Sql, organizationId: string, userId: string | null, propertyIds: string[], foundIn: string): Promise<AddResult> {
  if (propertyIds.length === 0) return { added: 0, already: 0 };
  const inserted = await sql`
    INSERT INTO prospects (organization_id, name, kind, address, city, state, zip, lon, lat, source, source_ref, found_in, created_by)
    SELECT p.organization_id, p.name, coalesce(p.property_type, ''), coalesce(p.address, ''), coalesce(p.city, ''), coalesce(p.state, ''), coalesce(p.zip, ''),
      ST_X(p.location::geometry), ST_Y(p.location::geometry), 'property', p.id::text,
      ${foundIn === '' ? sql`'Client: ' || c.name` : sql`${foundIn} || ' · Client: ' || c.name`}, ${userId}
    FROM properties p JOIN clients c ON c.id = p.client_id
    WHERE p.organization_id = ${organizationId} AND p.id = ANY(${propertyIds}::uuid[])
    ON CONFLICT (organization_id, source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING
    RETURNING id`;
  return { added: inserted.length, already: propertyIds.length - inserted.length };
}

export interface ProspectRow {
  id: string;
  name: string;
  kind: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  website: string;
  lon: number | null;
  lat: number | null;
  source: ProspectSource;
  foundIn: string;
  status: ProspectStatus;
  notes: string;
  calls: number;
  lastContactedAt: Date | null;
  followUpOn: string | null;
  addedBy: string | null;
  createdAt: Date;
}

/** An organization's prospects: those due for a follow-up first, then the newest. */
export async function listProspects(sql: Sql, organizationId: string, status: ProspectStatus | null, limit = 1000): Promise<ProspectRow[]> {
  const rows = await sql`
    SELECT p.id, p.name, p.kind, p.address, p.city, p.state, p.zip, p.phone, p.website, p.lon, p.lat, p.source, p.found_in, p.status, p.notes,
      p.calls, p.last_contacted_at, to_char(p.follow_up_on, 'YYYY-MM-DD') AS follow_up_on, u.name AS added_by, p.created_at
    FROM prospects p LEFT JOIN users u ON u.id = p.created_by
    WHERE p.organization_id = ${organizationId} ${status ? sql`AND p.status = ${status}` : sql``}
    ORDER BY (p.follow_up_on IS NOT NULL AND p.follow_up_on <= current_date) DESC, p.follow_up_on NULLS LAST, p.created_at DESC, p.name
    LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    address: r.address,
    city: r.city,
    state: r.state,
    zip: r.zip,
    phone: r.phone,
    website: r.website,
    lon: r.lon === null ? null : Number(r.lon),
    lat: r.lat === null ? null : Number(r.lat),
    source: r.source,
    foundIn: r.found_in,
    status: r.status,
    notes: r.notes,
    calls: r.calls,
    lastContactedAt: r.last_contacted_at,
    followUpOn: r.follow_up_on,
    addedBy: r.added_by,
    createdAt: r.created_at,
  }));
}

/** How many prospects an organization has in each status. */
export async function prospectCounts(sql: Sql, organizationId: string): Promise<Record<string, number>> {
  const rows = await sql`SELECT status, count(*)::int AS n FROM prospects WHERE organization_id = ${organizationId} GROUP BY status`;
  return Object.fromEntries(rows.map((r) => [r.status as string, r.n as number]));
}
