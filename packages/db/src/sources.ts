import { createHash } from 'node:crypto';
import type { SourceEvent } from '@hazard/core';
import type { Sql, Tx } from './client';

export type UpsertResult = 'create' | 'update' | 'skip';

function fingerprint(e: SourceEvent, bufferMeters: number | null): string {
  return createHash('sha1')
    .update(
      JSON.stringify([
        e.severity,
        e.eventName,
        e.headline,
        e.zoneCodes ?? null,
        e.point ?? null,
        e.radiusMeters ?? null,
        e.geometry ?? null,
        e.subtract?.length ?? 0,
        bufferMeters,
      ]),
    )
    .digest('hex');
}

/** SQL for the stored area: a buffered point, or the source polygon (cut and/or buffered). */
function areaSql(tx: Tx, e: SourceEvent, bufferMeters: number | null) {
  if (e.point) {
    const radius = e.radiusMeters ?? bufferMeters ?? 1000;
    return tx`ST_Buffer(ST_SetSRID(ST_MakePoint(${e.point.lon}, ${e.point.lat}), 4326)::geography, ${radius})::geometry`;
  }
  if (!e.geometry) return tx`NULL::geometry`;
  let area = tx`ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(e.geometry)}::text), 4326))`;
  if (e.subtract?.length) {
    area = tx`ST_Difference(${area}, (
      SELECT ST_Union(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(j), 4326)))
      FROM unnest(${e.subtract.map((g) => JSON.stringify(g))}::text[]) AS j))`;
  }
  if (bufferMeters && bufferMeters > 0) area = tx`ST_Buffer(${area}::geography, ${bufferMeters})::geometry`;
  return area;
}

/**
 * Store an event from a source that identifies events by a stable key (every source
 * except NWS, whose messages chain by reference). Creates the event, or updates it
 * when something that matters has changed; an unchanged repeat is a no-op.
 * Every stored change is also kept as a version.
 */
export async function upsertSourceEvent(
  sql: Sql,
  e: SourceEvent,
  opts: { bufferMeters?: number | null } = {},
): Promise<UpsertResult> {
  const bufferMeters = e.radiusMeters ? null : (opts.bufferMeters ?? null);
  const hash = fingerprint(e, bufferMeters);
  return sql.begin(async (tx) => {
    const [existing] = e.episodic
      ? await tx`
          SELECT id, content_hash, status FROM hazard_events
          WHERE source = ${e.source} AND split_part(source_event_id, '@', 1) = ${e.key} AND status = 'active'
          ORDER BY first_seen_at DESC LIMIT 1`
      : await tx`
          SELECT id, content_hash, status FROM hazard_events
          WHERE source = ${e.source} AND source_event_id = ${e.key}`;

    if (existing && existing.content_hash === hash && existing.status === 'active') {
      if (e.endsAt) await tx`UPDATE hazard_events SET ends_at = ${e.endsAt}::timestamptz WHERE id = ${existing.id}`;
      return 'skip';
    }

    const area = areaSql(tx, e, bufferMeters);
    const zones = e.zoneCodes ?? [];
    const raw = tx.json(e.raw as never);
    const details = tx.json(e.details as never);
    let eventId: string;
    let result: UpsertResult;

    if (!existing) {
      // A new episode at the same place gets its own event, so earlier notifications do not suppress it.
      const sourceEventId = e.episodic ? `${e.key}@${new Date().toISOString().slice(0, 16)}` : e.key;
      const [row] = await tx`
        INSERT INTO hazard_events (source, source_event_id, hazard_type, event_name, severity, native_severity,
          headline, description, area_desc, geometry, zone_codes, starts_at, ends_at, source_url, raw, details, content_hash)
        VALUES (${e.source}, ${sourceEventId}, ${e.hazardType}, ${e.eventName}, ${e.severity}::severity, ${e.nativeSeverity},
          ${e.headline}, ${e.description ?? null}, ${e.areaDesc}, ${area}, ${zones}::text[],
          ${e.startsAt}::timestamptz, ${e.endsAt}::timestamptz, ${e.sourceUrl}, ${raw}, ${details}, ${hash})
        RETURNING id`;
      eventId = row!.id;
      result = 'create';
    } else {
      eventId = existing.id;
      await tx`
        UPDATE hazard_events SET hazard_type = ${e.hazardType}, event_name = ${e.eventName},
          severity = ${e.severity}::severity, native_severity = ${e.nativeSeverity}, status = 'active',
          headline = ${e.headline}, description = ${e.description ?? null}, area_desc = ${e.areaDesc},
          geometry = ${e.mergeGeometry ? tx`ST_UnaryUnion(ST_Collect(geometry, ${area}))` : area},
          zone_codes = ${zones}::text[], starts_at = COALESCE(starts_at, ${e.startsAt}::timestamptz),
          ends_at = ${e.endsAt}::timestamptz, source_url = ${e.sourceUrl}, raw = ${raw}, details = ${details},
          content_hash = ${hash}, needs_evaluation = true, updated_at = now()
        WHERE id = ${eventId}`;
      result = 'update';
    }

    await tx`
      INSERT INTO hazard_event_versions (hazard_event_id, source, source_message_id, message_type, severity, sent_at, raw)
      VALUES (${eventId}, ${e.source}, ${`${e.key}#${hash.slice(0, 16)}@${Date.now()}`}, ${result === 'create' ? 'alert' : 'update'},
        ${e.severity}::severity, now(), ${raw})
      ON CONFLICT (source, source_message_id) DO NOTHING`;
    await tx`
      UPDATE hazard_events ev SET zones_pending = ev.geometry IS NULL AND EXISTS (
        SELECT 1 FROM unnest(ev.zone_codes) AS c(code)
        WHERE NOT EXISTS (SELECT 1 FROM geo_zones z WHERE z.code = c.code))
      WHERE ev.id = ${eventId}`;
    return result;
  });
}

/**
 * For feeds that list everything currently in effect (fire perimeters, storms, gauges in flood):
 * expire the source's active events that are no longer listed.
 */
export async function expireMissingKeys(sql: Sql, source: string, activeKeys: string[]): Promise<number> {
  const rows = await sql`
    UPDATE hazard_events SET status = 'expired', needs_evaluation = false, updated_at = now()
    WHERE source = ${source} AND status = 'active'
      AND NOT (split_part(source_event_id, '@', 1) = ANY(${activeKeys}::text[]))
    RETURNING id`;
  return rows.length;
}

/** For feeds of moment-in-time events (reports, detections, earthquakes): expire once the end time passes. */
export async function expireEnded(sql: Sql): Promise<number> {
  const rows = await sql`
    UPDATE hazard_events SET status = 'expired', needs_evaluation = false, updated_at = now()
    WHERE status = 'active' AND source <> 'nws' AND ends_at IS NOT NULL AND ends_at < now()
    RETURNING id`;
  return rows.length;
}

export interface FeedSetting {
  enabled: boolean;
  bufferMeters: number | null;
}

export async function getFeedSettings(sql: Sql): Promise<Map<string, FeedSetting>> {
  const rows = await sql`SELECT feed, enabled, buffer_meters FROM feed_settings`;
  return new Map(rows.map((r) => [r.feed as string, { enabled: r.enabled, bufferMeters: r.buffer_meters }]));
}

// ------------------------------------------------------------------ SMS caps

export interface SmsCaps {
  perEvent: number;
  perDay: number;
}
export const DEFAULT_SMS_CAPS: SmsCaps = { perEvent: 50, perDay: 200 };

export function readSmsCaps(settings: unknown): SmsCaps {
  const s = (settings ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback);
  return { perEvent: num(s.smsPerEventCap, DEFAULT_SMS_CAPS.perEvent), perDay: num(s.smsPerDayCap, DEFAULT_SMS_CAPS.perDay) };
}
