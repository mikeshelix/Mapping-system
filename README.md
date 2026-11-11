# Property Weather & Hazard Alert Platform

Answers one question: **which of our clients' properties are affected right now, how badly, and who needs to know?**

Staff plot client properties on a map. A worker watches free US government hazard feeds, matches each hazard
against the properties with PostGIS, and emails the right contacts.

Status: **Phase 1 (core alerting)**, **Phase 2 (more hazards, map layers, impact list, SMS)** and
**Phase 3 (rule builder, rule preview, exposure estimates, CSV export)** are built. Phase 4 is not started.

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

## What is in Phase 2

- Eight more hazard feeds (table below), each normalized to the common severity scale
- Toggleable map layers per hazard source, plus live radar
- Impacts screen: every affected property ranked worst first, with severity and client filters
- Text messages through Twilio: only to contacts with a recorded opt-in, STOP replies honoured,
  and per-event and per-day send caps an admin can change
- Settings screen: text message caps, and (for platform admins) feed switches and matching distances

## What is in Phase 3

- **Rule builder** with nine hazard templates (severe storms, hail, hurricane, flooding, wildfire, winter,
  earthquake, FEMA declarations, anything severe), severity thresholds, and coverage by all properties, chosen
  clients, chosen ZIP codes or chosen properties. Existing rules can be edited.
- **Rule preview**: replays the stored hazards of the last 90 days through the rule as filled in, and shows how
  many hazards, properties, contacts, emails and texts it would have produced. Nothing is saved or sent.
- **Estimated exposure** on the Impacts screen: declared value times a percentage per severity, set in Settings
  (defaults: minor 1%, moderate 5%, severe 15%, extreme 40%). Always labelled as an estimate.
- **CSV export** of properties, impacts and exposure.

### How the rule preview works

- It re-matches today's properties against the stored geometry of every hazard first seen in the last 90 days,
  so properties added after a hazard still count. It answers "what would this rule do for the portfolio I have now".
- It follows the live engine: one message per contact per hazard per channel, and a follow-up only where a
  later stored version of the hazard had a higher severity.
- Limits: it uses today's contacts and opt-ins, not those of the time; text counts are before send caps; and it
  can only reach back as far as the system has been collecting hazards (the screen says so when that is under 90 days).

### Exports

| Download | Contents |
|---|---|
| `/api/export/properties` | Every property, with coordinates and how it was located |
| `/api/export/impacts` | Properties affected by active hazards. Add `?days=90` for history |
| `/api/export/exposure` | One row per affected property: worst severity, declared value, assumed percentage, estimate |

All accept `?client=<id>` and `?severity=<minimum>`. Text that a spreadsheet would run as a formula is neutralized.

## What is in Phase 4

- **Assistant** (Ask tab on the map): staff ask questions about the portfolio in plain language. The model answers only from
  seven defined lookups, and can move the map to the properties or hazard it found.
- **Area search** (Area search tab): draw a shape on the map and list the businesses inside it, with your own properties in
  the shape listed first and a CSV download.
- **Usage metering**: every question is stored with its token counts and estimated cost, for per-transaction pricing.

### How the assistant is kept safe

- **Read-only by construction.** The lookups (`packages/db/src/assistant.ts`) run inside a `READ ONLY` database transaction
  with an 8-second statement timeout. There is no tool that writes, sends or deletes.
- **One organization only.** The organization comes from the signed-in session and is applied in every query; nothing the
  model sends can widen it. `show_on_map` drops any id that belongs to another organization. Tests cover this with two organizations.
- **No free-form SQL.** The model chooses a lookup and filters; filters are reduced to allowed values and passed as parameters.
- **Less personal data.** Contact emails and phone numbers are never returned to the model, only contact names.
  Property names, addresses, client names and declared values are sent to Anthropic when a question needs them.
- **Bounded cost.** At most 8 round trips per question, a monthly question limit per organization (admin setting, default 300),
  and a platform-wide monthly dollar ceiling (`ASSISTANT_MONTHLY_BUDGET_USD`, default 150) after which the assistant pauses.

The lookups: `portfolio_summary`, `search_properties`, `active_hazards`, `affected_properties`, `hazard_history`,
`notification_summary`, `show_on_map`.

### What a question costs

Each question is logged in `assistant_usage` (question, who asked, model, requests, lookups, input/output/cached tokens,
estimated cost, duration). Settings shows this month's count, total, average and most expensive question, and admins can
download the log as CSV (`/api/export/assistant`). Cost is estimated from the price table in `packages/core/src/assistant.ts`
(update it when prices change); the Anthropic invoice is the final figure. The default model is `claude-opus-5-5`
($4 per million input tokens, $20 per million output); `ASSISTANT_MODEL` and `ASSISTANT_EFFORT` change the model and how
much it deliberates.

### Area search data

Businesses come from OpenStreetMap through the Overpass API: free, no key, credited as "© OpenStreetMap contributors"
(ODbL licence). The public server asks for at most about 10,000 requests and 1 GB a day in total, so searches are limited to
100 square miles, 2,000 results and a daily count per organization (admin setting, default 200). It can be slow or refuse
requests when busy; the app retries once and waits up to a minute. For production volume, run your own Overpass server
and set `OVERPASS_URL`. OpenStreetMap is volunteer-maintained, so coverage varies and some businesses are missing.
Overture Maps Places is a fuller alternative but is distributed as large data files rather than a query service; it would
need to be loaded into PostGIS on a schedule.

## Layout

```
apps/web        Next.js (App Router): screens, server actions, /api/map, /api/assistant, /api/places
apps/worker     Node process: feed polling, matching, notification sending
packages/core   Pure logic: severity scale, NWS normalization, dedup, rule evaluation, message text, Census client
packages/db     SQL migrations, database client, the engine (ingest, match, queue notifications), assistant lookups
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

All free. Endpoints, formats and field names were checked against the live services on 2026-11-10.

| Feed | Source | Poll | What becomes an event | Area used for matching |
|---|---|---|---|---|
| `nws` | NWS alerts, `api.weather.gov/alerts/active` | 60 s | Each alert | Alert polygon, else its zones / counties |
| `spc` | SPC storm reports, `spc.noaa.gov/climo/reports/today_{torn,hail,wind}.csv` | 10 min | Each report | Point + 5 mi (configurable) |
| `mesh` | MRMS radar hail, `mrms.ncep.noaa.gov/2D/MESH_Max_60min/` | 10 min | Hail swath per day, 1-degree tile and size band | 0.01-degree grid cells with hail of 0.75 in or more |
| `nhc` | NHC `CurrentStorms.json` + NOAA tropical map service | 15 min | Forecast cone; each wind field band | Polygons (bands do not overlap) |
| `wfigs` | NIFC WFIGS current perimeters (ArcGIS) | 30 min | Each wildfire (prescribed burns excluded) | Perimeter + 2 mi (configurable) |
| `firms` | NASA FIRMS area API, VIIRS NOAA-20 and NOAA-21 | 15 min | Each detection | Point + 1.25 mi (configurable) |
| `nwps` | NOAA river gauges map service | 15 min | Each gauge at action stage or in flood | Point + 2 mi (configurable) |
| `usgs` | USGS earthquakes, `2.5_day.geojson` | 5 min | Each earthquake | Epicenter + radius by magnitude |
| `fema` | OpenFEMA `DisasterDeclarationsSummaries` | 6 h | Each declaration in the last 30 days | Designated counties |

Notes:

- **Flood stages.** The brief named USGS for stream-gauge flood stages. USGS publishes gauge readings but not
  flood categories; NOAA's National Water Prediction Service publishes both, so that is the source used.
- **FIRMS** needs a free key (`FIRMS_MAP_KEY`). Without it the feed is skipped and does not appear in feed health.
  The Suomi-NPP satellite stopped delivering on 2026-11-02, so NOAA-20 and NOAA-21 are used.
- **MRMS** files are GRIB2 with PNG packing. They are decoded in `apps/worker/src/feeds/mesh.ts` with no native
  library. Hail is a radar estimate, not a ground report.
- **Radar** on the map is NOAA's MRMS reflectivity mosaic (WMS at `opengeo.ncep.noaa.gov`).
- **Storm cell projections.** NWS storm-based warnings already carry the projected path as their polygon, which
  is what gets matched. Separate storm-track vectors are not ingested.

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
`unknown` events are stored and shown but **never** trigger a notification, whatever the rule says.
The mappings live in `packages/core/src/severity.ts` (NWS) and `packages/core/src/sources.ts` (all others),
each with tests. Change the code and this table together.

| Source | Native value | minor | moderate | severe | extreme |
|---|---|---|---|---|---|
| NWS alerts | CAP severity | Minor | Moderate | Severe | Extreme |
| SPC hail report, MRMS hail | Hail size | under 1.00 in | 1.00 to 1.74 in | 1.75 to 2.74 in | 2.75 in and larger |
| SPC wind report | Gust | under 58 mph | 58 to 74 mph, or damage with no measured speed | 75 to 99 mph | 100 mph and over |
| SPC tornado report | EF rating | | | Unrated, EF0, EF1 | EF2 and stronger |
| NHC forecast cone | Max sustained wind | under 34 kt (depression) | 34 to 63 kt (tropical storm) | 64 to 95 kt (hurricane) | 96 kt and over (major hurricane) |
| NHC wind field | Wind radius | | 34 kt | 50 kt | 64 kt |
| WFIGS wildfire | Size, then containment | 90%+ contained | under 100 acres | 100 to 4,999 acres | 5,000 acres and over |
| NASA FIRMS | VIIRS confidence | low | nominal | high | never |
| NOAA river gauge | Flood category | action stage | minor flooding | moderate flooding | major flooding |
| USGS earthquake | Magnitude | under 4.0 | 4.0 to 4.9 | 5.0 to 5.9 | 6.0 and over |
| FEMA declaration | Type | | EM, FM | DR | never |

Further rules:

- NWS "Unknown", and any missing or unrecognized value from any source, maps to `unknown`.
- MRMS hail under 0.75 in is ignored as too noisy.
- Wildfire 50 to 89% contained is rated one level lower than its size alone.
- A USGS PAGER alert raises an earthquake: yellow to at least severe, orange or red to extreme.
- River gauges are shifted up one step from NOAA's own names, because any flooding at a gauge is significant.
- Earthquake radius: under M4 15 km, M4 40 km, M5 100 km, M6 200 km, M7+ 300 km. This is a simplification;
  real shaking depends on depth and ground.

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
- **Sources without message chains** (everything except NWS) are stored by their own stable ID. A repeat poll
  that changes nothing is ignored; a real change updates the event and keeps a version. River gauges have no
  event ID, so each separate flood at a gauge becomes its own event.
- **Ending.** Sources that list what is in effect (fires, storms, gauges) expire an event when it is no longer
  listed. Moment-in-time sources (reports, detections, earthquakes) expire after 24 hours; hail swaths 12 hours
  after hail was last seen; FEMA declarations after 30 days.
- **Every message** states the hazard, severity, affected properties, issuing source, a map link, and the
  disclaimer that alerts supplement official warnings and do not replace them.

## Text messages

Off until Twilio is configured (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and a number or Messaging Service).
Twilio is a paid, usage-based service and US numbers must be registered (A2P 10DLC) before sending.

- A rule sends texts only if it is explicitly set to; email is always the default.
- Texts go only to contacts with a recorded opt-in. Consent is checked when the message is queued and again
  when it is sent.
- **STOP.** Point the Twilio number's inbound webhook at `TWILIO_WEBHOOK_URL` (`/api/sms/inbound`). Each request
  is verified with Twilio's signature. STOP (and UNSUBSCRIBE, CANCEL, END, QUIT, STOPALL, REVOKE, OPTOUT) records
  the opt-out and drops anything still queued for that number; START opts back in. Every inbound text is logged
  in `sms_events`. Twilio also blocks sends to opted-out numbers on its side.
- **Caps.** Each organization has a per-event and a per-day cap (defaults 50 and 200, changed in Settings).
  A text over the cap is recorded as `skipped` with the reason and is not retried.

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

- Geocoding runs inside the request; a 10,000-row file can take several minutes.
- The Census geocoder places addresses by interpolating along the street, so points can be off by a building or two.
- USGS imagery is published to zoom 16 and is stretched beyond that.
- Real sends through Brevo and Twilio, and the Twilio inbound webhook, have not been exercised against the live
  services (no credentials in the build environment).
- The FIRMS feed is written to the documented API but has not run against live data (no key).
- No hail or storm-report rows were live when this was built, so those parsers are verified by tests and by a real
  (hail-free) MRMS file, not by live matches.
- Exposure percentages are planning assumptions set by an admin; they are not derived from loss data.
- NWS alerts are drawn on the map only where they touch your properties; other sources are drawn nationwide.
- The assistant has not been run against the live Anthropic API (no key in the build environment). Its request loop is
  tested with a scripted stand-in for the model and its lookups against a real database; answer quality and real
  per-question cost are unmeasured until a key is added.
- The public Overpass server took 30 to 35 seconds per search and refused some requests while this was built.
