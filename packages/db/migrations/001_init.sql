CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Common severity scale. Enum order is the ranking: unknown < minor < ... < extreme.
-- 'unknown' events are stored but never notify.
CREATE TYPE severity AS ENUM ('unknown', 'minor', 'moderate', 'severe', 'extreme');

-- ---------------------------------------------------------------- tenants
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  settings    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email             text NOT NULL,
  name              text NOT NULL,
  password_hash     text,
  role              text NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  -- Platform admins (our own staff) receive feed-health alerts.
  is_platform_admin boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- portfolio
CREATE TABLE clients (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  color            text NOT NULL DEFAULT '#2563eb',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clients_org_idx ON clients (organization_id);

CREATE TABLE properties (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name             text NOT NULL,
  address          text,
  city             text,
  state            text,
  zip              text,
  location         geometry(Point, 4326) NOT NULL,
  geocode_source   text NOT NULL DEFAULT 'census' CHECK (geocode_source IN ('census', 'manual')),
  matched_address  text,
  property_type    text,
  declared_value   numeric(14, 2),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX properties_location_gix ON properties USING gist (location);
CREATE INDEX properties_org_idx ON properties (organization_id);
CREATE INDEX properties_client_idx ON properties (client_id);
CREATE INDEX properties_zip_idx ON properties (zip);

CREATE TABLE contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- A contact linked to a client receives alerts for all of that client's properties.
  client_id        uuid REFERENCES clients(id) ON DELETE CASCADE,
  name             text NOT NULL,
  email            text,
  mobile           text,
  sms_opt_in       boolean NOT NULL DEFAULT false,
  sms_opt_in_at    timestamptz,
  sms_opt_out_at   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_org_idx ON contacts (organization_id);
CREATE INDEX contacts_client_idx ON contacts (client_id);

-- A contact linked to specific properties receives alerts for only those.
CREATE TABLE contact_properties (
  contact_id   uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  property_id  uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, property_id)
);
CREATE INDEX contact_properties_property_idx ON contact_properties (property_id);

-- ---------------------------------------------------------------- hazards
-- Cached NWS forecast-zone and county polygons. Most NWS alerts carry no
-- polygon of their own and are defined only by these zone codes (UGC).
CREATE TABLE geo_zones (
  code        text PRIMARY KEY,
  kind        text NOT NULL,
  name        text,
  state       text,
  geometry    geometry(MultiPolygon, 4326),
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  fetch_error text
);
CREATE INDEX geo_zones_geometry_gix ON geo_zones USING gist (geometry);

-- One row per hazard event, holding its current state. Never deleted.
CREATE TABLE hazard_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source              text NOT NULL,
  source_event_id     text NOT NULL,
  current_message_id  text,
  hazard_type         text NOT NULL,
  event_name          text NOT NULL,
  severity            severity NOT NULL,
  native_severity     text,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired')),
  headline            text,
  description         text,
  instruction         text,
  area_desc           text,
  -- Polygon supplied by the source, when there is one.
  geometry            geometry(Geometry, 4326),
  -- Zone codes that define the area when the source supplies no polygon.
  zone_codes          text[] NOT NULL DEFAULT '{}',
  -- True while some zone polygons are still being fetched; the event is re-matched until false.
  zones_pending       boolean NOT NULL DEFAULT false,
  -- Set whenever the event, its zones, the portfolio or the rules change; the worker
  -- then re-runs spatial matching and rule evaluation and clears it.
  needs_evaluation    boolean NOT NULL DEFAULT true,
  starts_at           timestamptz,
  ends_at             timestamptz,
  source_url          text,
  raw                 jsonb NOT NULL,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_event_id)
);
CREATE INDEX hazard_events_geometry_gix ON hazard_events USING gist (geometry);
CREATE INDEX hazard_events_status_idx ON hazard_events (source, status);
CREATE INDEX hazard_events_first_seen_idx ON hazard_events (first_seen_at);
CREATE INDEX hazard_events_zone_codes_gin ON hazard_events USING gin (zone_codes);
CREATE INDEX hazard_events_needs_eval_idx ON hazard_events (id) WHERE needs_evaluation;

-- Every message received for an event (original, updates, cancellation).
CREATE TABLE hazard_event_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hazard_event_id    uuid NOT NULL REFERENCES hazard_events(id),
  source             text NOT NULL,
  source_message_id  text NOT NULL,
  message_type       text NOT NULL,
  severity           severity NOT NULL,
  sent_at            timestamptz,
  raw                jsonb NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_message_id)
);
CREATE INDEX hazard_event_versions_event_idx ON hazard_event_versions (hazard_event_id);

-- ---------------------------------------------------------------- rules
CREATE TABLE alert_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  enabled          boolean NOT NULL DEFAULT true,
  -- Empty array means every hazard type.
  hazard_types     text[] NOT NULL DEFAULT '{}',
  min_severity     severity NOT NULL DEFAULT 'moderate' CHECK (min_severity <> 'unknown'),
  -- all: every property in the organization; clients / properties: see join tables.
  scope            text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'clients', 'properties')),
  -- linked: contacts attached to the affected client or property; specific: see alert_rule_contacts.
  recipient_mode   text NOT NULL DEFAULT 'linked' CHECK (recipient_mode IN ('linked', 'specific')),
  channels         text[] NOT NULL DEFAULT '{email}',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_rules_org_idx ON alert_rules (organization_id);

CREATE TABLE alert_rule_clients (
  rule_id    uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  client_id  uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  PRIMARY KEY (rule_id, client_id)
);
CREATE TABLE alert_rule_properties (
  rule_id      uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  property_id  uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  PRIMARY KEY (rule_id, property_id)
);
CREATE TABLE alert_rule_contacts (
  rule_id     uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (rule_id, contact_id)
);

-- ---------------------------------------------------------------- impacts
CREATE TABLE property_impacts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hazard_event_id   uuid NOT NULL REFERENCES hazard_events(id),
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  severity          severity NOT NULL,
  first_matched_at  timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hazard_event_id, property_id)
);
CREATE INDEX property_impacts_org_idx ON property_impacts (organization_id, hazard_event_id);
CREATE INDEX property_impacts_property_idx ON property_impacts (property_id);

-- ---------------------------------------------------------------- notifications
-- One row per message: one contact, one event, one channel, listing all affected properties.
CREATE TABLE notifications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id           uuid REFERENCES contacts(id) ON DELETE SET NULL,
  hazard_event_id      uuid REFERENCES hazard_events(id),
  rule_id              uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
  kind                 text NOT NULL DEFAULT 'hazard' CHECK (kind IN ('hazard', 'system')),
  channel              text NOT NULL CHECK (channel IN ('email', 'sms')),
  severity             severity,
  is_escalation        boolean NOT NULL DEFAULT false,
  recipient            text NOT NULL,
  subject              text,
  body_html            text,
  body_text            text NOT NULL,
  status               text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts             int NOT NULL DEFAULT 0,
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  provider             text,
  provider_message_id  text,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz
);
CREATE INDEX notifications_queue_idx ON notifications (status, next_attempt_at);
CREATE INDEX notifications_org_idx ON notifications (organization_id, created_at DESC);

-- Which properties each message covered. The unique key is the hard guarantee that a
-- contact is never told twice about the same event + property at the same severity;
-- a follow-up row can only exist at a different (higher) severity.
CREATE TABLE notification_properties (
  notification_id  uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  contact_id       uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  hazard_event_id  uuid NOT NULL REFERENCES hazard_events(id),
  property_id      uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  channel          text NOT NULL,
  severity         severity NOT NULL,
  PRIMARY KEY (contact_id, hazard_event_id, property_id, channel, severity)
);
CREATE INDEX notification_properties_notification_idx ON notification_properties (notification_id);

-- ---------------------------------------------------------------- feed health
CREATE TABLE feed_status (
  feed                  text PRIMARY KEY,
  last_attempt_at       timestamptz,
  last_success_at       timestamptz,
  last_error            text,
  consecutive_failures  int NOT NULL DEFAULT 0,
  etag                  text,
  stale_after_seconds   int NOT NULL DEFAULT 600,
  stale_alerted_at      timestamptz
);

CREATE TABLE ingestion_runs (
  id                    bigserial PRIMARY KEY,
  feed                  text NOT NULL,
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  status                text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'not_modified', 'error')),
  http_status           int,
  events_seen           int NOT NULL DEFAULT 0,
  events_new            int NOT NULL DEFAULT 0,
  events_updated        int NOT NULL DEFAULT 0,
  events_cancelled      int NOT NULL DEFAULT 0,
  events_expired        int NOT NULL DEFAULT 0,
  impacts_created       int NOT NULL DEFAULT 0,
  notifications_queued  int NOT NULL DEFAULT 0,
  error                 text
);
CREATE INDEX ingestion_runs_feed_idx ON ingestion_runs (feed, started_at DESC);

-- ---------------------------------------------------------------- imports
CREATE TABLE import_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  filename         text NOT NULL,
  columns          text[] NOT NULL,
  mapping          jsonb,
  status           text NOT NULL DEFAULT 'mapping' CHECK (status IN ('mapping', 'review', 'committed', 'discarded')),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_rows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id         uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number       int NOT NULL,
  data             jsonb NOT NULL,
  name             text,
  address          text,
  city             text,
  state            text,
  zip              text,
  property_type    text,
  declared_value   numeric(14, 2),
  lon              double precision,
  lat              double precision,
  matched_address  text,
  geocode_status   text NOT NULL DEFAULT 'pending' CHECK (geocode_status IN ('pending', 'matched', 'failed', 'manual')),
  error            text
);
CREATE INDEX import_rows_batch_idx ON import_rows (batch_id, row_number);
