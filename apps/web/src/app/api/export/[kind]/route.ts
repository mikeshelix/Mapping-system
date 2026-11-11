import { NextResponse } from 'next/server';
import {
  estimateExposure,
  NOTIFIABLE_SEVERITIES,
  readExposureFactors,
  SEVERITY_LABELS,
  SOURCE_NAMES,
  toCsv,
  type Severity,
  type SourceId,
} from '@hazard/core';
import { getSql } from '@hazard/db';
import { getUser } from '@/lib/auth';
import { isUuid } from '@/lib/form';

export const dynamic = 'force-dynamic';

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : '');
const EXPOSURE_HEADER = 'Estimated exposure USD (estimate only, not a damage assessment)';

/**
 * CSV downloads for the signed-in organization:
 *   /api/export/properties            every property
 *   /api/export/impacts               properties affected by active hazards (add ?days=90 for history)
 *   /api/export/exposure              one row per affected property with its estimated exposure
 *   /api/export/assistant             every assistant question with its cost (admins only; add ?days=, default 90)
 * Optional filters: ?client=<id>, ?severity=<minimum>.
 */
export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { kind } = await params;
  const query = new URL(request.url).searchParams;
  const client = query.get('client');
  const clientId = client && isUuid(client) ? client : null;
  const severityParam = query.get('severity') ?? '';
  const minSeverity = (NOTIFIABLE_SEVERITIES as readonly string[]).includes(severityParam) ? (severityParam as Severity) : null;
  const days = Math.min(365, Math.max(0, Math.floor(Number(query.get('days')) || 0)));
  const sql = getSql();
  const org = user.organizationId;
  const [orgRow] = await sql`SELECT settings FROM organizations WHERE id = ${org}`;
  const factors = readExposureFactors(orgRow?.settings);
  const byClient = clientId ? sql`AND p.client_id = ${clientId}` : sql``;
  const bySeverity = minSeverity ? sql`AND i.severity >= ${minSeverity}::severity` : sql``;

  let csv: string;
  if (kind === 'properties') {
    const rows = await sql`
      SELECT c.name AS client, p.name, p.address, p.city, p.state, p.zip, p.property_type, p.declared_value,
        ST_Y(p.location) AS lat, ST_X(p.location) AS lon, p.geocode_source, p.matched_address, p.created_at
      FROM properties p JOIN clients c ON c.id = p.client_id
      WHERE p.organization_id = ${org} ${byClient}
      ORDER BY c.name, p.name`;
    csv = toCsv(
      ['Client', 'Property', 'Address', 'City', 'State', 'ZIP', 'Property type', 'Declared value USD', 'Latitude', 'Longitude', 'Located by', 'Matched address', 'Added'],
      rows.map((r) => [r.client, r.name, r.address, r.city, r.state, r.zip, r.property_type, r.declared_value, r.lat, r.lon,
        r.geocode_source === 'manual' ? 'Pin' : 'Address', r.matched_address, iso(r.created_at)]),
    );
  } else if (kind === 'impacts') {
    const window = days > 0 ? sql`e.first_seen_at >= now() - make_interval(days => ${days})` : sql`e.status = 'active'`;
    const rows = await sql`
      SELECT i.severity, i.first_matched_at, e.event_name, e.hazard_type, e.source, e.status, e.starts_at, e.ends_at, e.source_url,
        c.name AS client, p.name, p.address, p.city, p.state, p.zip, p.declared_value
      FROM property_impacts i
      JOIN hazard_events e ON e.id = i.hazard_event_id
      JOIN properties p ON p.id = i.property_id
      JOIN clients c ON c.id = p.client_id
      WHERE i.organization_id = ${org} AND ${window} ${byClient} ${bySeverity}
      ORDER BY i.severity DESC, i.first_matched_at DESC, p.name`;
    csv = toCsv(
      ['Severity', 'Client', 'Property', 'Address', 'City', 'State', 'ZIP', 'Hazard', 'Hazard type', 'Source', 'Hazard status',
        'First affected', 'Hazard start', 'Hazard end', 'Declared value USD', EXPOSURE_HEADER, 'Official link'],
      rows.map((r) => [SEVERITY_LABELS[r.severity as Severity], r.client, r.name, r.address, r.city, r.state, r.zip, r.event_name, r.hazard_type,
        SOURCE_NAMES[r.source as SourceId] ?? r.source, r.status, iso(r.first_matched_at), iso(r.starts_at), iso(r.ends_at), r.declared_value,
        estimateExposure(r.declared_value, r.severity as Severity, factors), r.source_url]),
    );
  } else if (kind === 'exposure') {
    const rows = await sql`
      SELECT c.name AS client, p.name, p.address, p.city, p.state, p.zip, p.property_type, p.declared_value,
        max(i.severity) AS severity, count(*)::int AS hazards,
        string_agg(DISTINCT e.event_name, '; ') AS hazard_names, min(i.first_matched_at) AS since
      FROM property_impacts i
      JOIN hazard_events e ON e.id = i.hazard_event_id AND e.status = 'active'
      JOIN properties p ON p.id = i.property_id
      JOIN clients c ON c.id = p.client_id
      WHERE i.organization_id = ${org} ${byClient} ${bySeverity}
      GROUP BY p.id, c.name
      ORDER BY max(i.severity) DESC, p.declared_value DESC NULLS LAST, p.name`;
    csv = toCsv(
      ['Client', 'Property', 'Address', 'City', 'State', 'ZIP', 'Property type', 'Worst current severity', 'Active hazards', 'Hazards',
        'Affected since', 'Declared value USD', 'Assumed percent exposed', EXPOSURE_HEADER],
      rows.map((r) => {
        const severity = r.severity as Severity;
        return [r.client, r.name, r.address, r.city, r.state, r.zip, r.property_type, SEVERITY_LABELS[severity], r.hazards, r.hazard_names,
          iso(r.since), r.declared_value, severity === 'unknown' ? 0 : Math.round(factors[severity] * 1000) / 10,
          estimateExposure(r.declared_value, severity, factors)];
      }),
    );
  } else if (kind === 'assistant') {
    if (user.role !== 'admin') return NextResponse.json({ error: 'Admins only' }, { status: 403 });
    const rows = await sql`
      SELECT a.created_at, u.name AS asked_by, a.question, a.status, a.model, a.requests, a.tool_calls,
        a.input_tokens, a.cache_read_tokens, a.cache_write_tokens, a.output_tokens, a.cost_usd, a.duration_ms
      FROM assistant_usage a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.organization_id = ${org} AND a.created_at >= now() - make_interval(days => ${days || 90})
      ORDER BY a.created_at DESC LIMIT 50000`;
    csv = toCsv(
      ['Asked at', 'Asked by', 'Question', 'Result', 'Model', 'Requests to the model', 'Lookups', 'Input tokens', 'Cached input tokens read',
        'Cached input tokens written', 'Output tokens', 'Estimated cost USD', 'Seconds'],
      rows.map((r) => [iso(r.created_at), r.asked_by, r.question, r.status, r.model, r.requests, r.tool_calls, r.input_tokens, r.cache_read_tokens,
        r.cache_write_tokens, r.output_tokens, r.cost_usd, Math.round(r.duration_ms / 100) / 10]),
    );
  } else {
    return NextResponse.json({ error: 'Unknown export' }, { status: 404 });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  // The byte-order mark makes Excel read the file as UTF-8.
  return new Response('﻿' + csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${kind}-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
