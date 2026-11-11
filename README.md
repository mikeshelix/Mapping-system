# Property Weather & Hazard Alert Platform

Answers one question: **which of our clients' properties are affected right now, how badly, and who needs to know?**

Staff plot client properties on a map. A worker watches free US government hazard feeds, matches each hazard
against the properties with PostGIS, and emails the right contacts.

Status: **Phase 1 (core alerting)** is built. Phases 2 to 4 are not started.

## What is in Phase 1

- Sign-in, organizations (one per subscriber), staff users with admin / staff roles
- Clients (with a map color), properties, contacts
- CSV / XLSX import: column mapping, US Census geocoding, and a review screen that flags rows that could not be
  located, lets you correct and retry them or drop a pin, and saves nothing until you confirm
- Map (MapLibre): properties colored by client, client filter toggles, active alert areas, street / satellite toggle
- NWS alert ingestion every 60 seconds, including updates, cancellations and expiry
- Spatial matching, alert rules, grouped email notifications through Brevo
- Feed health tracking, a warning banner when a feed is stale, and an email to platform admins
- Tests for severity mapping, spatial matching, deduplication and rule evaluation

## Layout

```
apps/web        Next.js (App Router): screens, server actions, /api/map
apps/worker     Node process: feed polling, matching, notification sending
packages/core   Pure logic: severity scale, NWS normalization, dedup, rule evaluation, message text, Census client
packages/db     SQL migrations, database client, and the engine (ingest, match, queue notifications)
```

## Running it locally

Needs Node 22+, pnpm and Docker.

```bash
cp .env.example .env
pnpm install
pnpm db:up        # PostGIS in Docker on port 5433
pnpm db:migrate
pnpm db:seed      # creates the organization and admin from SEED_* in .env
pnpm dev:worker   # in one terminal
pnpm dev:web      # in another; http://localhost:3000
pnpm test         # needs the database running
```

With `BREVO_API_KEY` empty, emails are written to the worker log instead of being sent.

## Hazard sources

| Source | Status | Poll | Notes |
|---|---|---|---|
| NWS alerts (`api.weather.gov/alerts/active`) | Phase 1, live | 60 s | Requires a `User-Agent`. NWS asks for no more than one request per 30 s. |
| SPC storm reports, MRMS hail, NHC, NIFC/WFIGS, NASA FIRMS, USGS, OpenFEMA | Phase 2 | | Not started |

### How NWS areas are matched

Only a small share of NWS alerts carry their own polygon (storm-based warnings such as tornado and severe
thunderstorm warnings). The rest are defined by a list of forecast zones or counties. So:

- if the alert has a polygon, properties are matched against that polygon;
- otherwise they are matched against the polygons of the alert's zones, which the worker fetches once from
  `api.weather.gov/zones/...` and caches in `geo_zones`.

A county-wide alert therefore affects every property in that county. Rules decide which of those are worth a
notification. Marine zones are never fetched, since no property can be in one.

## Severity scale

Every source is normalized to `minor`, `moderate`, `severe`, `extreme`, plus `unknown`.

| Source | Native value | Common scale |
|---|---|---|
| NWS | Extreme | extreme |
| NWS | Severe | severe |
| NWS | Moderate | moderate |
| NWS | Minor | minor |
| NWS | Unknown, missing or unrecognized | unknown |

`unknown` events are stored and shown but **never** trigger a notification, whatever the rule says.
The mapping lives in `packages/core/src/severity.ts`; each new source adds its own function and a row here.

## Alert engine rules

- **Identity.** NWS gives every update a new ID and lists the messages it replaces. A message belongs to an
  existing event if we already hold that message or any message it references. Every message is kept in
  `hazard_event_versions`; `hazard_events` holds the current state and is never deleted.
- **Cancel / expire.** A cancel message marks the event cancelled. An event that drops out of the active feed is
  marked expired.
- **No duplicates.** A contact is never told twice about the same event and property. A follow-up is sent only
  when severity rises, with the subject prefixed `UPGRADED:`. This is enforced in code and by the primary key on
  `notification_properties`.
- **Grouping.** One message per contact per event, listing all of that contact's affected properties.
- **Re-evaluation.** Adding properties, contacts or rules flags current events so they are re-checked; a new rule
  applies to hazards already in effect.
- **Every message** states the hazard, severity, affected properties, issuing source, a map link, and the
  disclaimer that alerts supplement official warnings and do not replace them.

## Reliability

- Each worker job runs in its own loop. A failing job backs off (up to 15 minutes) without affecting the others.
- Upstream calls retry with backoff; NWS responses are fetched conditionally with ETags; zone shapes are cached.
- Every poll is logged in `ingestion_runs`; every send attempt is recorded on the `notifications` row.
- `feed_status` tracks the last successful poll. Past the threshold (10 minutes for NWS) the app shows a banner
  and platform admins get one email per stale episode.

## Fitting into the Helixco suite

- **Auth** is behind one function, `getUser()` in `apps/web/src/lib/auth.ts`. Swap its body for the suite's
  session and nothing else changes. The built-in password sign-in is for standalone use.
- **Tenancy.** Each subscriber is an `organizations` row; every query is scoped by `organization_id`.
- **Email** goes through the `EmailProvider` interface in `apps/worker/src/providers.ts` (Brevo implemented).
- **Database.** Needs PostgreSQL with the PostGIS and pgcrypto extensions.
- **Maps.** Street tiles from OpenFreeMap and imagery from the USGS National Map: both free, no keys.

## Known limits in Phase 1

- Rules can cover all properties or chosen clients. The engine also supports per-property rules, but the screen
  for that comes with the Phase 3 rule builder.
- Geocoding runs inside the request; a 10,000-row file can take several minutes.
- The Census geocoder places addresses by interpolating along the street, so points can be off by a building or two.
- USGS imagery is published to zoom 16 and is stretched beyond that.
- SMS opt-in is recorded, but no text messages are sent until Phase 2.
