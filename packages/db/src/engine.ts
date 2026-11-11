import {
  decideIngest,
  isMarineZone,
  planNotifications,
  renderHazardEmail,
  renderHazardSms,
  SOURCE_NAMES,
  notifiedKey,
  type Channel,
  type ContactInput,
  type GeoJsonGeometry,
  type IngestDecision,
  type NormalizedAlert,
  type RuleInput,
  type Severity,
  type SourceId,
} from '@hazard/core';
import type { Sql, Tx } from './client';
import { readSmsCaps } from './sources';

// ------------------------------------------------------------------ ingest

export interface IngestResult {
  decision: IngestDecision;
  eventId: string;
}

/**
 * Store one incoming message. Creates the event, or applies the message to the
 * event it belongs to (see decideIngest). Every message is kept as a version.
 */
export async function ingestAlert(sql: Sql, alert: NormalizedAlert): Promise<IngestResult> {
  return sql.begin(async (tx) => {
    const ids = [alert.messageId, ...alert.references];
    const known = await tx`
      SELECT source_message_id, hazard_event_id FROM hazard_event_versions
      WHERE source = ${alert.source} AND source_message_id = ANY(${ids}::text[])`;
    const decision = decideIngest(
      alert,
      new Map(known.map((r) => [r.source_message_id as string, r.hazard_event_id as string])),
    );
    if (decision.action === 'skip') return { decision, eventId: decision.eventId };

    const geometry = alert.geometry ? JSON.stringify(alert.geometry) : null;
    // Marine zones are open water; no property can sit in one, so they are never fetched.
    const landZones = alert.zoneCodes.filter((c) => !isMarineZone(c));
    let eventId: string;

    if (decision.action === 'create') {
      const [row] = await tx`
        INSERT INTO hazard_events (
          source, source_event_id, current_message_id, hazard_type, event_name, severity, native_severity,
          status, headline, description, instruction, area_desc, geometry, zone_codes,
          starts_at, ends_at, source_url, raw
        ) VALUES (
          ${alert.source}, ${alert.messageId}, ${alert.messageId}, ${alert.hazardType}, ${alert.eventName},
          ${alert.severity}::severity, ${alert.nativeSeverity}, ${decision.status}, ${alert.headline},
          ${alert.description}, ${alert.instruction}, ${alert.areaDesc},
          ST_SetSRID(ST_GeomFromGeoJSON(${geometry}), 4326), ${landZones}::text[],
          ${alert.startsAt}::timestamptz, ${alert.endsAt}::timestamptz, ${alert.sourceUrl},
          ${tx.json(alert.raw as never)}
        )
        ON CONFLICT (source, source_event_id) DO UPDATE SET updated_at = now()
        RETURNING id`;
      eventId = row!.id as string;
    } else if (decision.action === 'cancel') {
      eventId = decision.eventId;
      await tx`
        UPDATE hazard_events SET status = 'cancelled', current_message_id = ${alert.messageId},
          needs_evaluation = false, updated_at = now()
        WHERE id = ${eventId}`;
    } else {
      eventId = decision.eventId;
      await tx`
        UPDATE hazard_events SET
          current_message_id = ${alert.messageId}, hazard_type = ${alert.hazardType}, event_name = ${alert.eventName},
          severity = ${alert.severity}::severity, native_severity = ${alert.nativeSeverity}, status = 'active',
          headline = ${alert.headline}, description = ${alert.description}, instruction = ${alert.instruction},
          area_desc = ${alert.areaDesc}, geometry = ST_SetSRID(ST_GeomFromGeoJSON(${geometry}), 4326),
          zone_codes = ${landZones}::text[], starts_at = ${alert.startsAt}::timestamptz,
          ends_at = ${alert.endsAt}::timestamptz, source_url = ${alert.sourceUrl},
          raw = ${tx.json(alert.raw as never)}, needs_evaluation = true, updated_at = now()
        WHERE id = ${eventId}`;
    }

    await tx`
      INSERT INTO hazard_event_versions (hazard_event_id, source, source_message_id, message_type, severity, sent_at, raw)
      VALUES (${eventId}, ${alert.source}, ${alert.messageId}, ${alert.messageType}, ${alert.severity}::severity,
              ${alert.sentAt}::timestamptz, ${tx.json(alert.raw as never)})
      ON CONFLICT (source, source_message_id) DO NOTHING`;
    await refreshZonesPending(tx, eventId);
    return { decision, eventId };
  });
}

async function refreshZonesPending(sql: Sql | Tx, eventId: string): Promise<void> {
  await sql`
    UPDATE hazard_events e SET zones_pending = e.geometry IS NULL AND EXISTS (
      SELECT 1 FROM unnest(e.zone_codes) AS c(code)
      WHERE NOT EXISTS (SELECT 1 FROM geo_zones z WHERE z.code = c.code))
    WHERE e.id = ${eventId}`;
}

/**
 * Mark events that have dropped out of the source's active list as expired.
 * Returns how many were expired.
 */
export async function expireMissing(sql: Sql, source: string, activeMessageIds: string[]): Promise<number> {
  const rows = await sql`
    UPDATE hazard_events SET status = 'expired', needs_evaluation = false, updated_at = now()
    WHERE source = ${source} AND status = 'active'
      AND NOT (current_message_id = ANY(${activeMessageIds}::text[]))
    RETURNING id`;
  return rows.length;
}

// ------------------------------------------------------------------ zones

/** Zone codes needed by active events that have not been fetched yet. */
export async function missingZoneCodes(sql: Sql, limit: number): Promise<string[]> {
  const rows = await sql`
    SELECT DISTINCT c.code FROM hazard_events e, unnest(e.zone_codes) AS c(code)
    WHERE e.status = 'active' AND e.zones_pending
      AND NOT EXISTS (SELECT 1 FROM geo_zones z WHERE z.code = c.code)
    LIMIT ${limit}`;
  return rows.map((r) => r.code as string);
}

export async function upsertZone(
  sql: Sql,
  zone: { code: string; kind: string; name: string | null; state: string | null; geometry: GeoJsonGeometry | null; error?: string },
): Promise<void> {
  const geometry = zone.geometry ? JSON.stringify(zone.geometry) : null;
  await sql.begin(async (tx) => {
    // Zone geometries arrive as Polygon, MultiPolygon or GeometryCollection; keep only the polygon parts.
    await tx`
      INSERT INTO geo_zones (code, kind, name, state, geometry, fetch_error)
      VALUES (${zone.code}, ${zone.kind}, ${zone.name}, ${zone.state},
        ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(${geometry}), 4326)), 3)),
        ${zone.error ?? null})
      ON CONFLICT (code) DO UPDATE SET kind = EXCLUDED.kind, name = EXCLUDED.name, state = EXCLUDED.state,
        geometry = EXCLUDED.geometry, fetch_error = EXCLUDED.fetch_error, fetched_at = now()`;
    await tx`
      UPDATE hazard_events e SET needs_evaluation = true,
        zones_pending = e.geometry IS NULL AND EXISTS (
          SELECT 1 FROM unnest(e.zone_codes) AS c(code)
          WHERE NOT EXISTS (SELECT 1 FROM geo_zones z WHERE z.code = c.code))
      WHERE e.status = 'active' AND ${zone.code} = ANY(e.zone_codes)`;
  });
}

// ------------------------------------------------------------------ matching

/**
 * Find every property inside an active event's area and record the impact.
 * An event with its own polygon is matched on that polygon; otherwise on the
 * cached polygons of its zones. Returns the number of newly created impacts.
 */
export async function matchEvent(sql: Sql, eventId: string): Promise<number> {
  const rows = await sql`
    WITH e AS (SELECT id, severity, geometry, zone_codes FROM hazard_events WHERE id = ${eventId} AND status = 'active'),
    hits AS (
      SELECT p.id, p.organization_id FROM e JOIN properties p ON ST_Intersects(e.geometry, p.location)
      WHERE e.geometry IS NOT NULL
      UNION
      SELECT p.id, p.organization_id FROM e
        JOIN geo_zones z ON z.code = ANY(e.zone_codes)
        JOIN properties p ON ST_Intersects(z.geometry, p.location)
      WHERE e.geometry IS NULL
    )
    INSERT INTO property_impacts (hazard_event_id, property_id, organization_id, severity)
    SELECT e.id, hits.id, hits.organization_id, e.severity FROM hits, e
    ON CONFLICT (hazard_event_id, property_id) DO UPDATE
      SET severity = EXCLUDED.severity, updated_at = now()
      WHERE property_impacts.severity <> EXCLUDED.severity
    RETURNING (xmax = 0) AS inserted`;
  return rows.filter((r) => r.inserted).length;
}

// ------------------------------------------------------------------ rules -> notifications

async function loadRules(sql: Sql, orgIds: string[]): Promise<RuleInput[]> {
  const rows = await sql`
    SELECT r.id, r.organization_id, r.enabled, r.hazard_types, r.min_severity, r.scope, r.recipient_mode, r.channels,
      COALESCE((SELECT array_agg(client_id::text) FROM alert_rule_clients WHERE rule_id = r.id), '{}') AS client_ids,
      COALESCE((SELECT array_agg(property_id::text) FROM alert_rule_properties WHERE rule_id = r.id), '{}') AS property_ids,
      COALESCE((SELECT array_agg(contact_id::text) FROM alert_rule_contacts WHERE rule_id = r.id), '{}') AS contact_ids
    FROM alert_rules r WHERE r.organization_id = ANY(${orgIds}::uuid[]) AND r.enabled
    ORDER BY r.created_at`;
  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    enabled: r.enabled,
    hazardTypes: r.hazard_types,
    minSeverity: r.min_severity,
    scope: r.scope,
    clientIds: r.client_ids,
    propertyIds: r.property_ids,
    recipientMode: r.recipient_mode,
    contactIds: r.contact_ids,
    channels: r.channels,
  }));
}

async function loadContacts(sql: Sql, orgIds: string[]): Promise<ContactInput[]> {
  const rows = await sql`
    SELECT c.id, c.organization_id, c.client_id, c.email, c.mobile, c.sms_opt_in, c.sms_opt_out_at,
      COALESCE((SELECT array_agg(property_id::text) FROM contact_properties WHERE contact_id = c.id), '{}') AS property_ids
    FROM contacts c WHERE c.organization_id = ANY(${orgIds}::uuid[])`;
  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    clientId: r.client_id,
    propertyIds: r.property_ids,
    email: r.email,
    mobile: r.mobile,
    smsOptIn: r.sms_opt_in && !r.sms_opt_out_at && !!r.mobile,
  }));
}

/**
 * Evaluate alert rules for one event and queue the resulting messages.
 * Returns the number of messages queued.
 */
export async function queueNotificationsForEvent(
  sql: Sql,
  eventId: string,
  opts: { appBaseUrl: string; enabledChannels?: Channel[] },
): Promise<number> {
  const [event] = await sql`
    SELECT id, source, hazard_type, event_name, severity, status, headline, instruction, area_desc, ends_at, source_url
    FROM hazard_events WHERE id = ${eventId}`;
  if (!event || event.status !== 'active' || event.severity === 'unknown') return 0;

  const impacts = await sql`
    SELECT i.property_id, i.organization_id, p.client_id, p.name, p.address, p.city, p.state, p.zip, c.name AS client_name
    FROM property_impacts i
    JOIN properties p ON p.id = i.property_id
    JOIN clients c ON c.id = p.client_id
    WHERE i.hazard_event_id = ${eventId}`;
  if (impacts.length === 0) return 0;

  const orgIds = [...new Set(impacts.map((i) => i.organization_id as string))];
  const [rules, contacts, prior] = await Promise.all([
    loadRules(sql, orgIds),
    loadContacts(sql, orgIds),
    sql`SELECT contact_id, property_id, channel, max(severity) AS severity
        FROM notification_properties WHERE hazard_event_id = ${eventId}
        GROUP BY contact_id, property_id, channel`,
  ]);
  if (rules.length === 0) return 0;

  const plans = planNotifications({
    event: { hazardType: event.hazard_type, severity: event.severity as Severity },
    impacts: impacts.map((i) => ({ propertyId: i.property_id, clientId: i.client_id, organizationId: i.organization_id })),
    rules,
    contacts,
    alreadyNotified: new Map(
      prior.map((r) => [notifiedKey(r.contact_id, r.property_id, r.channel), r.severity as Severity]),
    ),
    enabledChannels: opts.enabledChannels ?? ['email'],
  });
  if (plans.length === 0) return 0;

  const propertyInfo = new Map(impacts.map((i) => [i.property_id as string, i]));
  const contactRows = await sql`
    SELECT id, name, email, mobile FROM contacts WHERE id = ANY(${plans.map((p) => p.contactId)}::uuid[])`;
  const contactInfo = new Map(contactRows.map((c) => [c.id as string, c]));
  const mapUrl = `${opts.appBaseUrl.replace(/\/$/, '')}/?event=${eventId}`;

  // SMS send caps, per organization: at most N texts per event and N per day.
  const smsOrgs = [...new Set(plans.filter((p) => p.channel === 'sms').map((p) => p.organizationId))];
  const smsBudget = new Map<string, { perEvent: number; perDay: number }>();
  if (smsOrgs.length) {
    const rows = await sql`
      SELECT o.id, o.settings,
        (SELECT count(*)::int FROM notifications n WHERE n.organization_id = o.id AND n.channel = 'sms'
          AND n.status <> 'skipped' AND n.hazard_event_id = ${eventId}) AS for_event,
        (SELECT count(*)::int FROM notifications n WHERE n.organization_id = o.id AND n.channel = 'sms'
          AND n.status <> 'skipped' AND n.created_at >= date_trunc('day', now())) AS today
      FROM organizations o WHERE o.id = ANY(${smsOrgs}::uuid[])`;
    for (const r of rows) {
      const caps = readSmsCaps(r.settings);
      smsBudget.set(r.id, { perEvent: caps.perEvent - r.for_event, perDay: caps.perDay - r.today });
    }
  }

  let queued = 0;
  for (const plan of plans) {
    const contact = contactInfo.get(plan.contactId);
    const recipient = plan.channel === 'email' ? contact?.email : contact?.mobile;
    if (!contact || !recipient) continue;

    const properties = plan.propertyIds
      .map((id) => propertyInfo.get(id))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const sourceName = SOURCE_NAMES[event.source as SourceId] ?? event.source;
    const emailMessage = renderHazardEmail({
      eventName: event.event_name,
      severity: plan.severity,
      headline: event.headline,
      instruction: event.instruction,
      areaDesc: event.area_desc,
      sourceName,
      sourceUrl: event.source_url,
      endsAt: event.ends_at ? new Date(event.ends_at).toISOString() : null,
      isEscalation: plan.isEscalation,
      contactName: contact.name,
      properties: properties.map((p) => ({
        name: p.name,
        address: [p.address, p.city, p.state, p.zip].filter(Boolean).join(', ') || null,
        clientName: p.client_name,
      })),
      mapUrl,
    });
    let message: { subject: string | null; html: string | null; text: string } = emailMessage;
    let skipReason: string | null = null;
    if (plan.channel === 'sms') {
      message = {
        subject: null,
        html: null,
        text: renderHazardSms({
          eventName: event.event_name,
          severity: plan.severity,
          sourceName,
          isEscalation: plan.isEscalation,
          properties: properties.map((p) => ({ name: p.name, address: null, clientName: p.client_name })),
          mapUrl,
        }),
      };
      const budget = smsBudget.get(plan.organizationId);
      if (budget && budget.perEvent <= 0) skipReason = 'Not sent: the per-event text message cap was reached.';
      else if (budget && budget.perDay <= 0) skipReason = 'Not sent: the daily text message cap was reached.';
      else if (budget) {
        budget.perEvent--;
        budget.perDay--;
      }
    }

    const inserted = await sql.begin(async (tx) => {
      const [n] = await tx`
        INSERT INTO notifications (organization_id, contact_id, hazard_event_id, rule_id, channel, severity,
          is_escalation, recipient, subject, body_html, body_text, status, error)
        VALUES (${plan.organizationId}, ${plan.contactId}, ${eventId}, ${plan.ruleId}, ${plan.channel},
          ${plan.severity}::severity, ${plan.isEscalation}, ${recipient}, ${message.subject}, ${message.html}, ${message.text},
          ${skipReason ? 'skipped' : 'queued'}, ${skipReason})
        RETURNING id`;
      const rows = properties.map((p) => ({
        notification_id: n!.id as string,
        contact_id: plan.contactId,
        hazard_event_id: eventId,
        property_id: p.property_id as string,
        channel: plan.channel,
        severity: plan.severity,
      }));
      // The primary key is the final guard against duplicates, e.g. two workers racing.
      const kept = await tx`
        INSERT INTO notification_properties ${tx(rows)}
        ON CONFLICT DO NOTHING RETURNING property_id`;
      if (kept.length === 0) {
        await tx`DELETE FROM notifications WHERE id = ${n!.id}`;
        return false;
      }
      return true;
    });
    if (inserted && !skipReason) queued++;
  }
  return queued;
}

/**
 * Match and evaluate every event flagged for evaluation.
 */
export async function evaluatePendingEvents(
  sql: Sql,
  opts: { appBaseUrl: string; enabledChannels?: Channel[]; limit?: number },
): Promise<{ events: number; impactsCreated: number; notificationsQueued: number }> {
  const pending = await sql`
    SELECT id FROM hazard_events WHERE needs_evaluation AND status = 'active'
    ORDER BY severity DESC, updated_at LIMIT ${opts.limit ?? 2000}`;
  let impactsCreated = 0;
  let notificationsQueued = 0;
  for (const { id } of pending) {
    impactsCreated += await matchEvent(sql, id);
    notificationsQueued += await queueNotificationsForEvent(sql, id, opts);
    await sql`UPDATE hazard_events SET needs_evaluation = false WHERE id = ${id}`;
  }
  return { events: pending.length, impactsCreated, notificationsQueued };
}

/**
 * Call after properties, contacts or rules change so current hazards are re-checked.
 * With an organization, only events already touching that organization are flagged
 * (enough for rule and contact edits); without one, every active event is flagged
 * (needed when properties are added, since they may fall inside any event).
 */
export async function flagActiveEvents(sql: Sql, organizationId?: string): Promise<void> {
  if (organizationId) {
    await sql`
      UPDATE hazard_events SET needs_evaluation = true
      WHERE status = 'active' AND id IN (
        SELECT hazard_event_id FROM property_impacts WHERE organization_id = ${organizationId})`;
  } else {
    await sql`UPDATE hazard_events SET needs_evaluation = true WHERE status = 'active'`;
  }
}

// ------------------------------------------------------------------ feed health

export async function startRun(sql: Sql, feed: string): Promise<number> {
  await sql`
    INSERT INTO feed_status (feed, last_attempt_at) VALUES (${feed}, now())
    ON CONFLICT (feed) DO UPDATE SET last_attempt_at = now()`;
  const [row] = await sql`INSERT INTO ingestion_runs (feed) VALUES (${feed}) RETURNING id`;
  return Number(row!.id);
}

export interface RunStats {
  status: 'ok' | 'not_modified' | 'error';
  httpStatus?: number | null;
  eventsSeen?: number;
  eventsNew?: number;
  eventsUpdated?: number;
  eventsCancelled?: number;
  eventsExpired?: number;
  impactsCreated?: number;
  notificationsQueued?: number;
  error?: string | null;
  etag?: string | null;
}

export async function finishRun(sql: Sql, feed: string, runId: number, s: RunStats): Promise<void> {
  await sql`
    UPDATE ingestion_runs SET finished_at = now(), status = ${s.status}, http_status = ${s.httpStatus ?? null},
      events_seen = ${s.eventsSeen ?? 0}, events_new = ${s.eventsNew ?? 0}, events_updated = ${s.eventsUpdated ?? 0},
      events_cancelled = ${s.eventsCancelled ?? 0}, events_expired = ${s.eventsExpired ?? 0},
      impacts_created = ${s.impactsCreated ?? 0}, notifications_queued = ${s.notificationsQueued ?? 0},
      error = ${s.error ?? null}
    WHERE id = ${runId}`;
  if (s.status === 'error') {
    await sql`
      UPDATE feed_status SET last_error = ${s.error ?? 'unknown error'}, consecutive_failures = consecutive_failures + 1
      WHERE feed = ${feed}`;
  } else {
    await sql`
      UPDATE feed_status SET last_success_at = now(), last_error = NULL, consecutive_failures = 0,
        stale_alerted_at = NULL, etag = COALESCE(${s.etag ?? null}, etag)
      WHERE feed = ${feed}`;
  }
}

export interface FeedHealth {
  feed: string;
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  staleAfterSeconds: number;
  stale: boolean;
  staleAlertedAt: Date | null;
}

export async function getFeedHealth(sql: Sql): Promise<FeedHealth[]> {
  const rows = await sql`
    -- A feed that has never succeeded is measured from when it was first registered.
    SELECT *, (COALESCE(last_success_at, created_at) < now() - make_interval(secs => stale_after_seconds)) AS stale
    FROM feed_status ORDER BY feed`;
  return rows.map((r) => ({
    feed: r.feed,
    lastSuccessAt: r.last_success_at,
    lastAttemptAt: r.last_attempt_at,
    lastError: r.last_error,
    consecutiveFailures: r.consecutive_failures,
    staleAfterSeconds: r.stale_after_seconds,
    stale: r.stale,
    staleAlertedAt: r.stale_alerted_at,
  }));
}
