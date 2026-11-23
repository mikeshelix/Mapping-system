/**
 * Forecast heads-ups: the database side. The worker fetches the forecasts; this decides
 * who is told what, and records it so nobody is told the same thing twice.
 */
import { headsUpKey, planForecastHeadsUps, renderForecastEmail, ruleCoversImpact, type FlaggedPeriod, type RuleInput } from '@hazard/core';
import type { Sql } from './client';
import { loadContacts, loadRules } from './engine';

export interface ForecastProperty {
  id: string;
  organizationId: string;
  clientId: string;
  clientName: string;
  name: string;
  address: string | null;
  zip: string | null;
  lon: number;
  lat: number;
}

export interface ForecastWork {
  rules: RuleInput[];
  /** Every location covered by at least one rule that asks for forecast heads-ups. */
  properties: ForecastProperty[];
}

/** The rules that ask for heads-ups and the locations they cover. Empty when no rule asks, so nothing is fetched. */
export async function loadForecastWork(sql: Sql): Promise<ForecastWork> {
  const orgs = await sql`SELECT DISTINCT organization_id FROM alert_rules WHERE enabled AND forecast_heads_up`;
  if (orgs.length === 0) return { rules: [], properties: [] };
  const orgIds = orgs.map((o) => o.organization_id as string);
  const rules = (await loadRules(sql, orgIds)).filter((r) => r.forecastHeadsUp);
  const rows = await sql`
    SELECT p.id, p.organization_id, p.client_id, c.name AS client_name, p.name, p.zip,
      NULLIF(concat_ws(', ', p.address, p.city, p.state, p.zip), '') AS address, ST_X(p.location) AS lon, ST_Y(p.location) AS lat
    FROM properties p JOIN clients c ON c.id = p.client_id
    WHERE p.organization_id = ANY(${orgIds}::uuid[])`;
  const properties = rows
    .map((r): ForecastProperty => ({
      id: r.id, organizationId: r.organization_id, clientId: r.client_id, clientName: r.client_name,
      name: r.name, address: r.address, zip: r.zip, lon: Number(r.lon), lat: Number(r.lat),
    }))
    .filter((p) => rules.some((rule) => ruleCoversImpact(rule, { propertyId: p.id, clientId: p.clientId, organizationId: p.organizationId, zip: p.zip })));
  return { rules, properties };
}

/** Known forecast grids for these points. A point that is missing has not been looked up yet. */
export async function getForecastGrids(sql: Sql, points: string[]): Promise<Map<string, string | null>> {
  if (points.length === 0) return new Map();
  const rows = await sql`SELECT point, forecast_url FROM forecast_grids WHERE point = ANY(${points}::text[])`;
  return new Map(rows.map((r) => [r.point as string, r.forecast_url as string | null]));
}

export async function saveForecastGrid(sql: Sql, point: string, forecastUrl: string | null): Promise<void> {
  await sql`
    INSERT INTO forecast_grids (point, forecast_url) VALUES (${point}, ${forecastUrl})
    ON CONFLICT (point) DO UPDATE SET forecast_url = EXCLUDED.forecast_url, checked_at = now()`;
}

/**
 * Queue one email per contact for flagged weather they have not been told about yet.
 * Returns the number of emails queued.
 */
export async function queueForecastHeadsUps(
  sql: Sql,
  work: ForecastWork,
  flaggedByProperty: ReadonlyMap<string, FlaggedPeriod[]>,
  opts: { appBaseUrl: string },
): Promise<number> {
  const flagged = work.properties
    .map((p) => ({ property: p, periods: flaggedByProperty.get(p.id) ?? [] }))
    .filter((f) => f.periods.length > 0);
  if (flagged.length === 0 || work.rules.length === 0) return 0;

  const orgIds = [...new Set(flagged.map((f) => f.property.organizationId))];
  const propertyIds = flagged.map((f) => f.property.id);
  const [contacts, prior] = await Promise.all([
    loadContacts(sql, orgIds),
    sql`SELECT contact_id, property_id, concern, to_char(forecast_day, 'YYYY-MM-DD') AS day
        FROM forecast_heads_ups WHERE property_id = ANY(${propertyIds}::uuid[]) AND forecast_day >= current_date - 3`,
  ]);
  const plans = planForecastHeadsUps({
    rules: work.rules,
    flagged: flagged.map((f) => ({
      propertyId: f.property.id,
      clientId: f.property.clientId,
      organizationId: f.property.organizationId,
      zip: f.property.zip,
      // A day period and its night can flag the same thing; that is one item.
      items: [...new Map(f.periods.flatMap((p) => p.concerns.map((concern) => [`${p.day}|${concern}`, { day: p.day, concern }] as const))).values()],
    })),
    contacts,
    alreadySent: new Set(prior.map((r) => headsUpKey(r.contact_id, { propertyId: r.property_id, day: r.day, concern: r.concern }))),
  });
  if (plans.length === 0) return 0;

  const info = new Map(flagged.map((f) => [f.property.id, f]));
  const contactRows = await sql`SELECT id, name, email FROM contacts WHERE id = ANY(${plans.map((p) => p.contactId)}::uuid[])`;
  const contactInfo = new Map(contactRows.map((c) => [c.id as string, c]));
  const mapUrl = `${opts.appBaseUrl.replace(/\/$/, '')}/`;

  let queued = 0;
  for (const plan of plans) {
    const contact = contactInfo.get(plan.contactId);
    if (!contact?.email) continue;
    const newByProperty = new Map<string, Set<string>>();
    for (const item of plan.items) {
      if (!newByProperty.has(item.propertyId)) newByProperty.set(item.propertyId, new Set());
      newByProperty.get(item.propertyId)!.add(`${item.day}|${item.concern}`);
    }
    const properties = [...newByProperty.entries()]
      .map(([propertyId, fresh]) => {
        const f = info.get(propertyId)!;
        return {
          name: f.property.name,
          address: f.property.address,
          clientName: f.property.clientName,
          // Show a period when at least one of its concerns is new to this contact, listing only the new ones.
          periods: f.periods
            .map((p) => ({ name: p.name, shortForecast: p.shortForecast, concerns: p.concerns.filter((c) => fresh.has(`${p.day}|${c}`)) }))
            .filter((p) => p.concerns.length > 0),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const message = renderForecastEmail({ contactName: contact.name, properties, mapUrl });

    const inserted = await sql.begin(async (tx) => {
      const [n] = await tx`
        INSERT INTO notifications (organization_id, contact_id, rule_id, kind, channel, recipient, subject, body_html, body_text)
        VALUES (${plan.organizationId}, ${plan.contactId}, ${plan.ruleId}, 'forecast', 'email', ${contact.email}, ${message.subject}, ${message.html}, ${message.text})
        RETURNING id`;
      const rows = plan.items.map((i) => ({ contact_id: plan.contactId, property_id: i.propertyId, concern: i.concern, forecast_day: i.day, notification_id: n!.id as string }));
      // The primary key is the final guard against duplicates, e.g. two workers racing.
      const kept = await tx`INSERT INTO forecast_heads_ups ${tx(rows)} ON CONFLICT DO NOTHING RETURNING property_id`;
      if (kept.length === 0) {
        await tx`DELETE FROM notifications WHERE id = ${n!.id}`;
        return false;
      }
      return true;
    });
    if (inserted) queued++;
  }
  return queued;
}
