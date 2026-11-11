import { replayRule, type ReplayEvent, type RuleInput, type RulePreview, type Severity } from '@hazard/core';
import type { Sql } from './client';
import { loadContacts } from './engine';

export const PREVIEW_DAYS = 90;

/**
 * Every stored event from the last `days` days that covers at least one of the
 * organization's current properties, with those properties.
 *
 * The match is recomputed from stored geometry rather than read from
 * property_impacts, so properties added after an event are still counted: the
 * question is what the rule would do for today's portfolio.
 */
export async function loadReplayEvents(sql: Sql, organizationId: string, days = PREVIEW_DAYS): Promise<ReplayEvent[]> {
  const rows = await sql`
    WITH hits AS (
      SELECT e.id AS event_id, p.id AS property_id, p.client_id, p.zip
      FROM properties p
      JOIN hazard_events e ON e.geometry IS NOT NULL AND ST_Intersects(e.geometry, p.location)
      WHERE p.organization_id = ${organizationId} AND e.first_seen_at >= now() - make_interval(days => ${days})
      UNION
      SELECT e.id, p.id, p.client_id, p.zip
      FROM properties p
      JOIN geo_zones z ON ST_Intersects(z.geometry, p.location)
      JOIN hazard_events e ON e.geometry IS NULL AND e.zone_codes @> ARRAY[z.code]
      WHERE p.organization_id = ${organizationId} AND e.first_seen_at >= now() - make_interval(days => ${days})
    )
    SELECT e.id, e.hazard_type, e.event_name, e.first_seen_at, e.severity,
      (SELECT array_agg(v.severity ORDER BY v.created_at, v.sent_at) FROM hazard_event_versions v WHERE v.hazard_event_id = e.id) AS severities,
      json_agg(json_build_object('propertyId', h.property_id, 'clientId', h.client_id, 'zip', h.zip)) AS impacts
    FROM hits h JOIN hazard_events e ON e.id = h.event_id
    GROUP BY e.id
    ORDER BY e.first_seen_at`;
  return rows.map((r) => ({
    id: r.id,
    hazardType: r.hazard_type,
    eventName: r.event_name,
    firstSeenAt: new Date(r.first_seen_at).toISOString(),
    severities: (r.severities as Severity[] | null)?.length ? (r.severities as Severity[]) : [r.severity as Severity],
    impacts: (r.impacts as Array<{ propertyId: string; clientId: string; zip: string | null }>).map((i) => ({ ...i, organizationId })),
  }));
}

export interface RulePreviewResult extends RulePreview {
  days: number;
  /** When the oldest stored event was first seen; the replay cannot reach back further than this. */
  historyStart: string | null;
}

/** Replay the last 90 days of stored events through a rule (saved or still being drafted). */
export async function previewRule(sql: Sql, rule: RuleInput, days = PREVIEW_DAYS): Promise<RulePreviewResult> {
  const [events, contacts, [oldest]] = await Promise.all([
    loadReplayEvents(sql, rule.organizationId, days),
    loadContacts(sql, [rule.organizationId]),
    sql`SELECT min(first_seen_at) AS first FROM hazard_events`,
  ]);
  // A preview answers "would this contact be texted", so recorded opt-in still applies (loadContacts handles it).
  return {
    ...replayRule(rule, contacts, events),
    days,
    historyStart: oldest?.first ? new Date(oldest.first).toISOString() : null,
  };
}
