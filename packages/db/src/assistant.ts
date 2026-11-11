/**
 * Phase 4: the assistant's tools, usage metering, and area-search bookkeeping.
 *
 * Every tool runs inside a READ ONLY transaction with a statement timeout and is
 * scoped to one organization by the caller-supplied id (never by anything the
 * model sends), so whatever the model asks for it can only read that
 * organization's data.
 */
import {
  cleanCommon,
  cleanEnum,
  cleanInt,
  cleanText,
  cleanUuid,
  estimateCostUsd,
  estimateExposure,
  readExposureFactors,
  type ExposureFactors,
  type Severity,
  type TokenUsage,
} from '@hazard/core';
import type { Sql, Tx } from './client';

/** What show_on_map hands back for the browser to draw. */
export interface MapAction {
  title: string;
  points: Array<{ id: string; name: string; lon: number; lat: number }>;
  eventId: string | null;
  eventName: string | null;
  /** [west, south, east, north] of the hazard, when one was given and has a shape. */
  bbox: [number, number, number, number] | null;
}

export interface ToolOutcome {
  result: unknown;
  map?: MapAction;
}

const TOOL_TIMEOUT_MS = 8000;
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const like = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Worst current severity per property, for one organization. */
const worstCte = (tx: Tx, org: string) => tx`
  worst AS (
    SELECT i.property_id, max(i.severity) AS severity
    FROM property_impacts i JOIN hazard_events e ON e.id = i.hazard_event_id AND e.status = 'active'
    WHERE i.organization_id = ${org} GROUP BY i.property_id
  )`;

function exposureOf(hits: Array<{ v: number | string | null; s: Severity }> | null, factors: ExposureFactors): number {
  let total = 0;
  for (const h of hits ?? []) total += estimateExposure(h.v, h.s, factors) ?? 0;
  return Math.round(total);
}

async function portfolioSummary(tx: Tx, org: string, factors: ExposureFactors, input: Record<string, unknown>): Promise<ToolOutcome> {
  const groupBy = cleanEnum(input.group_by, ['none', 'client', 'state', 'zip', 'property_type'] as const, 'none');
  const key = {
    none: tx`'all'::text`,
    client: tx`c.name`,
    state: tx`COALESCE(NULLIF(upper(p.state), ''), '(none)')`,
    zip: tx`COALESCE(NULLIF(left(p.zip, 5), ''), '(none)')`,
    property_type: tx`COALESCE(NULLIF(p.property_type, ''), '(none)')`,
  }[groupBy];
  const rows = await tx`
    WITH ${worstCte(tx, org)}
    SELECT ${key} AS key, count(*)::int AS properties, COALESCE(sum(p.declared_value), 0) AS declared_value,
      count(p.declared_value)::int AS with_value, count(w.property_id)::int AS affected,
      json_agg(json_build_object('v', p.declared_value, 's', w.severity)) FILTER (WHERE w.property_id IS NOT NULL) AS hits,
      count(*) OVER()::int AS total
    FROM properties p JOIN clients c ON c.id = p.client_id LEFT JOIN worst w ON w.property_id = p.id
    WHERE p.organization_id = ${org}
    GROUP BY 1 ORDER BY count(w.property_id) DESC, count(*) DESC, 1 LIMIT 200`;
  const groups = rows.map((r) => ({
    ...(groupBy === 'none' ? {} : { [groupBy]: r.key }),
    properties: r.properties,
    properties_with_declared_value: r.with_value,
    total_declared_value_usd: Math.round(Number(r.declared_value)),
    affected_now: r.affected,
    estimated_exposure_usd: exposureOf(r.hits, factors),
  }));
  if (groupBy === 'none') return { result: groups[0] ?? { properties: 0, affected_now: 0 } };
  const total = rows[0]?.total ?? 0;
  return { result: { group_by: groupBy, groups, total_groups: total, ...(total > groups.length ? { truncated: true } : {}) } };
}

async function searchProperties(tx: Tx, org: string, factors: ExposureFactors, input: Record<string, unknown>): Promise<ToolOutcome> {
  const f = cleanCommon(input);
  const city = cleanText(input.city);
  const zip = cleanText(input.zip, 10);
  const type = cleanText(input.property_type);
  const text = cleanText(input.text);
  const minValue = typeof input.min_declared_value === 'number' && Number.isFinite(input.min_declared_value) ? input.min_declared_value : null;
  const affected = cleanEnum(input.affected, ['any', 'affected', 'unaffected'] as const, 'any');
  const rows = await tx`
    WITH ${worstCte(tx, org)}
    SELECT p.id, p.name, concat_ws(', ', p.address, p.city, p.state, p.zip) AS address, c.name AS client,
      p.property_type, p.declared_value, w.severity, count(*) OVER()::int AS total
    FROM properties p JOIN clients c ON c.id = p.client_id LEFT JOIN worst w ON w.property_id = p.id
    WHERE p.organization_id = ${org}
      ${f.client ? tx`AND c.name ILIKE ${like(f.client)}` : tx``}
      ${f.state ? tx`AND upper(p.state) = ${f.state}` : tx``}
      ${city ? tx`AND p.city ILIKE ${like(city)}` : tx``}
      ${zip ? tx`AND p.zip LIKE ${zip.slice(0, 5) + '%'}` : tx``}
      ${type ? tx`AND p.property_type ILIKE ${like(type)}` : tx``}
      ${text ? tx`AND (p.name ILIKE ${like(text)} OR p.address ILIKE ${like(text)})` : tx``}
      ${minValue !== null ? tx`AND p.declared_value >= ${minValue}` : tx``}
      ${affected === 'affected' ? tx`AND w.property_id IS NOT NULL` : affected === 'unaffected' ? tx`AND w.property_id IS NULL` : tx``}
    ORDER BY w.severity DESC NULLS LAST, p.declared_value DESC NULLS LAST, p.name
    LIMIT ${f.limit}`;
  const total = rows[0]?.total ?? 0;
  return {
    result: {
      total_matching: total,
      ...(total > rows.length ? { truncated: true } : {}),
      properties: rows.map((r) => ({
        id: r.id,
        name: r.name,
        address: r.address,
        client: r.client,
        property_type: r.property_type,
        declared_value_usd: num(r.declared_value),
        worst_current_severity: r.severity ?? 'not affected',
        ...(r.severity ? { estimated_exposure_usd: estimateExposure(r.declared_value, r.severity, factors) } : {}),
      })),
    },
  };
}

async function activeHazards(tx: Tx, org: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  const f = cleanCommon(input);
  const rows = await tx`
    SELECT e.id, e.event_name, e.hazard_type, e.severity, e.source, e.headline, e.area_desc, e.starts_at, e.ends_at,
      count(*)::int AS properties, count(*) OVER()::int AS total
    FROM hazard_events e
    JOIN property_impacts i ON i.hazard_event_id = e.id AND i.organization_id = ${org}
    JOIN properties p ON p.id = i.property_id
    WHERE e.status = 'active'
      ${f.hazardTypes.length ? tx`AND e.hazard_type IN ${tx(f.hazardTypes)}` : tx``}
      ${f.minSeverity ? tx`AND e.severity >= ${f.minSeverity}::severity` : tx``}
      ${f.state ? tx`AND upper(p.state) = ${f.state}` : tx``}
    GROUP BY e.id ORDER BY e.severity DESC, count(*) DESC, e.first_seen_at DESC LIMIT ${f.limit}`;
  const total = rows[0]?.total ?? 0;
  return {
    result: {
      total_hazards: total,
      ...(total > rows.length ? { truncated: true } : {}),
      hazards: rows.map((r) => ({
        id: r.id,
        name: r.event_name,
        hazard_type: r.hazard_type,
        severity: r.severity,
        source: r.source,
        headline: r.headline ? String(r.headline).slice(0, 300) : null,
        area: r.area_desc ? String(r.area_desc).slice(0, 200) : null,
        starts_at: iso(r.starts_at),
        ends_at: iso(r.ends_at),
        properties_affected: r.properties,
      })),
    },
  };
}

async function affectedProperties(tx: Tx, org: string, factors: ExposureFactors, input: Record<string, unknown>): Promise<ToolOutcome> {
  const f = cleanCommon(input);
  const eventId = cleanUuid(input.event_id);
  if (input.event_id !== undefined && input.event_id !== null && !eventId) return { result: { error: 'event_id is not a valid hazard id. Use an id returned by active_hazards.' } };
  const where = tx`
    i.organization_id = ${org}
    ${eventId ? tx`AND e.id = ${eventId}` : tx``}
    ${f.hazardTypes.length ? tx`AND e.hazard_type IN ${tx(f.hazardTypes)}` : tx``}
    ${f.minSeverity ? tx`AND i.severity >= ${f.minSeverity}::severity` : tx``}
    ${f.client ? tx`AND c.name ILIKE ${like(f.client)}` : tx``}
    ${f.state ? tx`AND upper(p.state) = ${f.state}` : tx``}`;
  const from = tx`
    FROM property_impacts i
    JOIN hazard_events e ON e.id = i.hazard_event_id AND e.status = 'active'
    JOIN properties p ON p.id = i.property_id
    JOIN clients c ON c.id = p.client_id`;
  const [rows, [totals]] = await Promise.all([
    tx`
      SELECT p.id AS property_id, p.name, concat_ws(', ', p.address, p.city, p.state, p.zip) AS address, c.name AS client,
        p.declared_value, i.severity, i.first_matched_at, e.id AS event_id, e.event_name, e.hazard_type
      ${from} WHERE ${where}
      ORDER BY i.severity DESC, p.declared_value DESC NULLS LAST, p.name LIMIT ${f.limit}`,
    tx`SELECT count(*)::int AS rows, count(DISTINCT i.property_id)::int AS properties, count(DISTINCT e.id)::int AS hazards ${from} WHERE ${where}`,
  ]);
  return {
    result: {
      distinct_properties_affected: totals!.properties,
      hazards_involved: totals!.hazards,
      total_rows: totals!.rows,
      ...(totals!.rows > rows.length ? { truncated: true } : {}),
      rows: rows.map((r) => ({
        property_id: r.property_id,
        property: r.name,
        address: r.address,
        client: r.client,
        severity: r.severity,
        hazard: r.event_name,
        hazard_type: r.hazard_type,
        event_id: r.event_id,
        affected_since: iso(r.first_matched_at),
        declared_value_usd: num(r.declared_value),
        estimated_exposure_usd: estimateExposure(r.declared_value, r.severity, factors),
      })),
    },
  };
}

async function hazardHistory(tx: Tx, org: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  const f = cleanCommon(input);
  const days = cleanInt(input.days, 1, 365, 30);
  const groupBy = cleanEnum(input.group_by, ['hazard_type', 'client', 'state', 'month'] as const, 'hazard_type');
  const key = {
    hazard_type: tx`e.hazard_type`,
    client: tx`c.name`,
    state: tx`COALESCE(NULLIF(upper(p.state), ''), '(none)')`,
    month: tx`to_char(date_trunc('month', i.first_matched_at), 'YYYY-MM')`,
  }[groupBy];
  const where = tx`
    i.organization_id = ${org} AND i.first_matched_at >= now() - make_interval(days => ${days})
    ${f.hazardTypes.length ? tx`AND e.hazard_type IN ${tx(f.hazardTypes)}` : tx``}
    ${f.minSeverity ? tx`AND i.severity >= ${f.minSeverity}::severity` : tx``}
    ${f.client ? tx`AND c.name ILIKE ${like(f.client)}` : tx``}
    ${f.state ? tx`AND upper(p.state) = ${f.state}` : tx``}`;
  const from = tx`
    FROM property_impacts i
    JOIN hazard_events e ON e.id = i.hazard_event_id
    JOIN properties p ON p.id = i.property_id
    JOIN clients c ON c.id = p.client_id`;
  const [groups, [totals], [oldest]] = await Promise.all([
    tx`
      SELECT ${key} AS key, count(DISTINCT e.id)::int AS hazards, count(DISTINCT i.property_id)::int AS properties, max(i.severity) AS worst
      ${from} WHERE ${where} GROUP BY 1 ORDER BY count(DISTINCT e.id) DESC, 1 LIMIT 200`,
    tx`SELECT count(DISTINCT e.id)::int AS hazards, count(DISTINCT i.property_id)::int AS properties ${from} WHERE ${where}`,
    tx`SELECT min(first_seen_at) AS first FROM hazard_events`,
  ]);
  return {
    result: {
      days,
      records_begin: iso(oldest?.first),
      distinct_hazards: totals!.hazards,
      distinct_properties_affected: totals!.properties,
      group_by: groupBy,
      groups: groups.map((g) => ({ [groupBy]: g.key, hazards: g.hazards, properties_affected: g.properties, worst_severity: g.worst })),
    },
  };
}

async function notificationSummary(tx: Tx, org: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  const days = cleanInt(input.days, 1, 90, 7);
  const eventId = cleanUuid(input.event_id);
  const propertyId = cleanUuid(input.property_id);
  const where = tx`
    n.organization_id = ${org} AND n.kind = 'hazard' AND n.created_at >= now() - make_interval(days => ${days})
    ${eventId ? tx`AND n.hazard_event_id = ${eventId}` : tx``}
    ${propertyId ? tx`AND EXISTS (SELECT 1 FROM notification_properties np WHERE np.notification_id = n.id AND np.property_id = ${propertyId})` : tx``}`;
  const [counts, recent] = await Promise.all([
    tx`SELECT n.channel, n.status, count(*)::int AS messages, count(DISTINCT n.contact_id)::int AS contacts FROM notifications n WHERE ${where} GROUP BY 1, 2 ORDER BY 1, 2`,
    // Contact names only: addresses and phone numbers are never given to the model.
    tx`
      SELECT n.channel, n.status, n.severity, n.is_escalation, n.created_at, n.sent_at, k.name AS contact, e.event_name
      FROM notifications n LEFT JOIN contacts k ON k.id = n.contact_id LEFT JOIN hazard_events e ON e.id = n.hazard_event_id
      WHERE ${where} ORDER BY n.created_at DESC LIMIT 25`,
  ]);
  return {
    result: {
      days,
      counts: counts.map((c) => ({ channel: c.channel === 'sms' ? 'text' : c.channel, status: c.status, messages: c.messages, contacts: c.contacts })),
      most_recent: recent.map((r) => ({
        contact: r.contact ?? '(removed contact)',
        channel: r.channel === 'sms' ? 'text' : r.channel,
        status: r.status,
        hazard: r.event_name,
        severity: r.severity,
        follow_up: r.is_escalation,
        queued_at: iso(r.created_at),
        sent_at: iso(r.sent_at),
      })),
    },
  };
}

async function showOnMap(tx: Tx, org: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  const ids = [...new Set((Array.isArray(input.property_ids) ? input.property_ids : []).map(cleanUuid).filter((v): v is string => !!v))].slice(0, 500);
  const eventId = cleanUuid(input.event_id);
  const title = cleanText(input.title, 120) ?? 'Results';
  const points = ids.length
    ? await tx`SELECT id, name, ST_X(location) AS lon, ST_Y(location) AS lat FROM properties WHERE organization_id = ${org} AND id IN ${tx(ids)}`
    : [];
  let eventName: string | null = null;
  let bbox: MapAction['bbox'] = null;
  let foundEvent = false;
  if (eventId) {
    const [e] = await tx`
      SELECT e.event_name, ST_XMin(g.geom) AS w, ST_YMin(g.geom) AS s, ST_XMax(g.geom) AS e, ST_YMax(g.geom) AS n
      FROM hazard_events e
      LEFT JOIN LATERAL (
        SELECT ST_Envelope(COALESCE(e.geometry, (SELECT ST_Union(z.geometry) FROM geo_zones z WHERE z.code = ANY(e.zone_codes)))) AS geom
      ) g ON true
      WHERE e.id = ${eventId}`;
    if (e) {
      foundEvent = true;
      eventName = e.event_name;
      if (e.w !== null) bbox = [Number(e.w), Number(e.s), Number(e.e), Number(e.n)];
    }
  }
  if (points.length === 0 && !foundEvent) {
    return { result: { shown: false, error: 'None of those ids belong to this portfolio. Use ids exactly as returned by the other tools.' } };
  }
  return {
    result: { shown: true, properties_highlighted: points.length, hazard_outlined: eventName },
    map: {
      title,
      points: points.map((p) => ({ id: p.id, name: p.name, lon: Number(p.lon), lat: Number(p.lat) })),
      eventId: foundEvent ? eventId : null,
      eventName,
      bbox,
    },
  };
}

/**
 * Run one assistant tool for one organization. Unknown tools and bad input come
 * back as an `error` result for the model to read rather than as exceptions.
 */
export async function runAssistantTool(sql: Sql, organizationId: string, name: string, rawInput: unknown): Promise<ToolOutcome> {
  const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : {};
  return sql.begin('read only', async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${TOOL_TIMEOUT_MS}`);
    const [org] = await tx`SELECT settings FROM organizations WHERE id = ${organizationId}`;
    if (!org) return { result: { error: 'Unknown organization' } };
    const factors = readExposureFactors(org.settings);
    switch (name) {
      case 'portfolio_summary':
        return portfolioSummary(tx, organizationId, factors, input);
      case 'search_properties':
        return searchProperties(tx, organizationId, factors, input);
      case 'active_hazards':
        return activeHazards(tx, organizationId, input);
      case 'affected_properties':
        return affectedProperties(tx, organizationId, factors, input);
      case 'hazard_history':
        return hazardHistory(tx, organizationId, input);
      case 'notification_summary':
        return notificationSummary(tx, organizationId, input);
      case 'show_on_map':
        return showOnMap(tx, organizationId, input);
      default:
        return { result: { error: `Unknown tool: ${name}` } };
    }
  }) as Promise<ToolOutcome>;
}

// ------------------------------------------------------------------ metering

export interface AssistantUsageRecord {
  organizationId: string;
  userId: string | null;
  question: string;
  model: string;
  status: 'ok' | 'error' | 'refused' | 'incomplete';
  requests: number;
  toolCalls: number;
  usage: TokenUsage;
  durationMs: number;
  error?: string | null;
}

/** Store what one question cost. Returns the estimated dollar cost (null when the model's price is unknown). */
export async function recordAssistantUsage(sql: Sql, r: AssistantUsageRecord): Promise<number | null> {
  const cost = estimateCostUsd(r.model, r.usage);
  await sql`
    INSERT INTO assistant_usage (organization_id, user_id, question, model, status, requests, tool_calls,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, error)
    VALUES (${r.organizationId}, ${r.userId}, ${r.question.slice(0, 2000)}, ${r.model}, ${r.status}, ${r.requests}, ${r.toolCalls},
      ${r.usage.inputTokens}, ${r.usage.outputTokens}, ${r.usage.cacheReadTokens}, ${r.usage.cacheWriteTokens}, ${cost}, ${r.durationMs},
      ${r.error ? r.error.slice(0, 500) : null})`;
  return cost;
}

export interface AssistantUsageSummary {
  questions: number;
  answered: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  averageCostUsd: number | null;
  highestCostUsd: number | null;
}

/** This calendar month's (UTC) assistant use, for one organization or, with null, the whole platform. */
export async function assistantUsageThisMonth(sql: Sql, organizationId: string | null): Promise<AssistantUsageSummary> {
  const [r] = await sql`
    SELECT count(*)::int AS questions, count(*) FILTER (WHERE status = 'ok')::int AS answered,
      COALESCE(sum(cost_usd), 0) AS cost, COALESCE(sum(input_tokens + cache_read_tokens + cache_write_tokens), 0)::bigint AS input_tokens,
      COALESCE(sum(output_tokens), 0)::bigint AS output_tokens, avg(cost_usd) FILTER (WHERE status = 'ok') AS average, max(cost_usd) AS highest
    FROM assistant_usage
    WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      ${organizationId ? sql`AND organization_id = ${organizationId}` : sql``}`;
  return {
    questions: r!.questions,
    answered: r!.answered,
    costUsd: Number(r!.cost),
    inputTokens: Number(r!.input_tokens),
    outputTokens: Number(r!.output_tokens),
    averageCostUsd: r!.average === null ? null : Number(r!.average),
    highestCostUsd: r!.highest === null ? null : Number(r!.highest),
  };
}

// ------------------------------------------------------------------ area searches

/** The organization's own properties inside a drawn polygon (GeoJSON, lon/lat). */
export async function propertiesInArea(sql: Sql, organizationId: string, polygon: { type: 'Polygon'; coordinates: number[][][] }) {
  const rows = await sql`
    SELECT p.id, p.name, concat_ws(', ', p.address, p.city, p.state, p.zip) AS address, c.name AS client,
      ST_X(p.location) AS lon, ST_Y(p.location) AS lat
    FROM properties p JOIN clients c ON c.id = p.client_id
    WHERE p.organization_id = ${organizationId}
      AND ST_Intersects(p.location, ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(polygon)}), 4326))
    ORDER BY c.name, p.name LIMIT 2000`;
  return rows.map((r) => ({ id: r.id as string, name: r.name as string, address: r.address as string, client: r.client as string, lon: Number(r.lon), lat: Number(r.lat) }));
}

export async function areaSearchesToday(sql: Sql, organizationId: string): Promise<number> {
  const [r] = await sql`
    SELECT count(*)::int AS n FROM area_searches
    WHERE organization_id = ${organizationId} AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  return r!.n;
}

export async function recordAreaSearch(
  sql: Sql,
  r: { organizationId: string; userId: string | null; polygon: { type: 'Polygon'; coordinates: number[][][] }; category: string; source: string; resultCount: number; status: 'ok' | 'error'; error?: string | null; durationMs: number },
): Promise<void> {
  await sql`
    INSERT INTO area_searches (organization_id, user_id, area, category, source, result_count, status, error, duration_ms)
    VALUES (${r.organizationId}, ${r.userId}, ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(r.polygon)}), 4326), ${r.category}, ${r.source},
      ${r.resultCount}, ${r.status}, ${r.error ? r.error.slice(0, 500) : null}, ${r.durationMs})`;
}
