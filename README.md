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
(update it when prices change); the Anthropic invoice is the final figure. On a developer machine the app also accepts a
sign-in saved by `ant auth login`; servers should set `ANTHROPIC_API_KEY`. The default model is `claude-opus-5-5`
($4 per million input tokens, $20 per million output); `ASSISTANT_MODEL` and `ASSISTANT_EFFORT` change the model and how
much it deliberates.

### Area search data

Businesses come from Overture Maps places, read in place with DuckDB (see "Businesses layer" below): free, open licence, no key.
A search is limited to 500 square miles, 5,000 results and a daily count per organization (admin setting, default 200). Businesses
Overture marks as permanently closed, or with confidence of 0.7 or less, are left out. A dense city centre can hold far more than
5,000 businesses; the result then says it is partial and suggests picking a kind of business or a smaller area.

## The map screen

One screen shows everything, with no tabs to switch between:

- **Weather** is picked by pattern (storms and hail, tornado, flood, hurricane, wildfire, winter, heat, earthquake, other, plus
  live radar), each in its own color, with a count of active alerts. "At my locations" shows only weather touching the
  portfolio; "Everywhere" shows the whole country. Darker shading means more severe. Patterns are defined in
  `packages/core/src/weather.ts`; every hazard type belongs to exactly one.
- **Locations** can be filtered by client and location type, limited to affected ones, and colored by client, type or
  status. Nearby pins merge into a numbered bubble (red edge when one inside is affected) until you zoom in.
- **Search** finds a location by name, client or address. Clicking a pin opens a card with what is affecting it and who gets alerts.
- **Ask a question** and **Find businesses in an area** open in a panel on the right of the same map.

The top menu has four items: Map, Portfolio (clients, locations, contacts, import), Alerts (affected now, rules, sent
messages) and Admin (data feeds, users, settings).

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
| `wfigs` | NIFC WFIGS current perimeters and incident locations (ArcGIS) | 30 min | Each wildfire (prescribed burns excluded). A fire with no mapped perimeter yet is a point; it becomes a shape when the perimeter is published | Perimeter + 2 mi, or reported point + 2 mi (configurable) |
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
| WFIGS wildfire | Size, then containment | 90%+ contained; or no perimeter and under 10 acres or size not reported | under 100 acres | 100 to 4,999 acres | 5,000 acres and over |
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
- The assistant was run live on four questions against a seven-property test portfolio: answers matched the database,
  the map moved, and a request to delete, email and read other organizations was declined. Cost was $0.025 to $0.042
  per question on `claude-opus-5-5`. It has not been measured on a portfolio of thousands of properties, where
  lookups return more text and cost more.
- Business search now reads Overture Maps; the earlier public OpenStreetMap server (30 to 35 seconds per search) is no longer used.

## Google place search in the assistant (demo)

Optional, and off unless `GOOGLE_MAPS_API_KEY` is set. With a key, the assistant gets one extra tool, `nearby_businesses`, which asks Google Maps Platform's Maps Experience agent tools (`POST https://mapstools.googleapis.com/v1:searchText`, verified 2026-11-23) for businesses near a portfolio location or a named town.

- **Cost:** requests stay on the Essentials tier (five places, no extended details), which has 10,000 no-charge requests a month. `GOOGLE_PLACES_MONTHLY_CAP` (default 9,000, counted across all organizations in `place_lookups`) stops lookups before that allowance runs out.
- **What is sent to Google:** the search words and, when a location is named, its coordinates. Nothing else about the portfolio.
- **What is kept:** only the search words and a count. Google's results are shown to the person who asked and are not stored.
- **Attribution:** every answer that used Google lists its Google Maps sources, with links, directly under the answer.
- **Not on the map:** Google results are listed, not plotted, because the map is not a Google map.

Before this is offered to customers, two things in Google's terms need a person to read them: the rule on showing Google content beside a non-Google map, and the rule that the AI model used must not train on or keep Google Maps content.

## Forecasts and forecast heads-ups

Each location card shows the next three days from the National Weather Service (`api.weather.gov/points/{lat},{lon}`, then the gridpoint forecast it names; verified 2026-11-23; free, no key, United States only). Periods that mention thunderstorms, snow, ice, heavy rain, tropical or other severe weather, or wind of 30 mph (gusts of 40 mph) or more are marked "Worth watching". That marking reads the forecaster's own words; it is a prompt to look closer, not a warning.

A rule can also ask for **forecast heads-ups** (off by default). The worker then checks the forecast for every location the rule covers every three hours (`FORECAST_POLL_SECONDS`) and emails the rule's contacts when a location first shows flagged weather starting in the next 48 hours.

- One email per contact per check, listing every new item across their locations.
- A contact is told about the same kind of weather, at the same location, on the same day only once (`forecast_heads_ups`).
- Email only. The rule's hazard types and minimum severity do not apply to heads-ups; its locations and recipients do.
- Locations close together share one forecast request, and the grid a location falls in is looked up once and remembered (`forecast_grids`). When no rule asks for heads-ups, nothing is fetched.
- Official watches and warnings are separate and still go out as alerts.

Not yet measured: how long the first check takes for a portfolio of thousands of locations (new locations are looked up at most 2,000 per check).

## Businesses layer (Overture Maps via DuckDB)

The map's "Businesses" switch shows businesses and points of interest in the current view, from the Overture Maps places data (open licence, free, no key). There is no extra database and nothing is downloaded up front: DuckDB (`@duckdb/node-api`, running inside the web server) reads only the parts of Overture's public GeoParquet files that cover the view, over HTTPS.

- **Latest data without a hardcoded date:** the release is read from `https://stac.overturemaps.org/catalog.json` (`latest`), then the places collection and its 16 file entries, each with a bounding box. Only files overlapping the view are queried. The list is cached for six hours.
- **Query:** name, `basic_category`, confidence, position, first address, phone and website, where the view's bounding box matches, `confidence > 0.7`, `LIMIT 200`, most confident first. The optional filter matches name or category and is passed as a query parameter. Note: Overture removed `categories` in September 2026; `basic_category` replaces it.
- **When it runs:** only with the switch on, at zoom 13 or closer, 0.4 seconds after the map stops moving. A newer request cancels the one before it.
- **Speed (measured 2026-11-23):** 10 to 15 seconds the first time an area's file is touched after a server start, then about 0.3 to 5 seconds; a repeated view is answered from a one-hour cache in milliseconds.
- **Start-up cost:** none. DuckDB loads on the first business request. On its first ever run on a machine it downloads its `httpfs` and `spatial` extensions from `extensions.duckdb.org`, so the server needs outbound HTTPS to that host and to `overturemaps-us-west-2.s3.us-west-2.amazonaws.com` and `stac.overturemaps.org`.
- **Deployment:** `@duckdb/node-api` is a native module (listed in `serverExternalPackages`), so it must be installed on the server's own platform. DuckDB is limited to 1 GB of memory and four threads.

"Find businesses in an area" and the alert button use the same data and the same DuckDB connection: every business inside the outline (`ST_Contains`), by name, filtered by Overture's top-level category group. Measured on central Houston: about 6,800 businesses in a 7 square mile triangle in 1 second once the file had been touched.

## Prospects

The Clients page has a second tab, Prospects: businesses and locations a user wants to call on.

- **Adding from the map.** Every business in an area search has a "+ Prospect" button, and "Add all to prospects" sends the whole list. Business pop-ups on the
  map have "Add to prospects" too. The organization's own locations inside a searched area can be added the same way. A business is only ever on the list once
  (matched on its Overture id), so pressing the button twice is harmless.
- **Tracking.** Each prospect has a status (New, Called, Follow up, Interested, Not interested, Won), a follow-up date, notes, and an "I called them" button
  that counts the call and stamps the date. Follow-ups that are due sort to the top.
- **Getting the list out.** "Download list (CSV)" on the tab, or `/api/export/prospects`.
- **What is stored.** Only open data from Overture Maps and what the user types. Nothing returned by Google's place search is ever stored.
- **Connecting a sales system later.** The `prospects` table has an unused `external_ref` column for the id of the matching record in an outside CRM.
  Nothing is sent anywhere yet.

Business website links (in the area list, map pop-ups and the prospect list) open in a small separate window so the list behind them is not lost.
Ctrl/Cmd-click still opens a normal tab.
