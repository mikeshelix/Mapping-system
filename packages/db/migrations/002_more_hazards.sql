-- Phase 2: more hazard sources, SMS.

-- Source-specific measurements (hail size, wind speed, magnitude, acres ...) for display.
ALTER TABLE hazard_events ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
-- Fingerprint of the last stored state, used to tell a real change from a repeat poll.
ALTER TABLE hazard_events ADD COLUMN content_hash text;
CREATE INDEX hazard_events_active_ends_idx ON hazard_events (ends_at) WHERE status = 'active';

-- Per-feed settings an admin can change without a deploy.
CREATE TABLE feed_settings (
  feed           text PRIMARY KEY,
  enabled        boolean NOT NULL DEFAULT true,
  -- Distance added around point events (and fire perimeters) when matching properties.
  buffer_meters  int CHECK (buffer_meters IS NULL OR buffer_meters BETWEEN 0 AND 200000)
);
INSERT INTO feed_settings (feed, buffer_meters) VALUES
  ('nws', NULL),
  ('spc', 8000),     -- storm reports: about 5 miles
  ('mesh', NULL),    -- radar hail grid: matched cell by cell
  ('nhc', NULL),     -- forecast cone and wind fields are polygons
  ('wfigs', 3200),   -- wildfire perimeters: about 2 miles beyond the perimeter
  ('firms', 2000),   -- satellite fire detections: about 1.25 miles
  ('nwps', 3200),    -- river gauges in flood: about 2 miles
  ('usgs', NULL),    -- earthquakes: radius depends on magnitude
  ('fema', NULL);    -- declarations: whole counties

-- A message that was deliberately not sent (send cap reached, contact opted out).
ALTER TABLE notifications DROP CONSTRAINT notifications_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped'));

-- Every inbound text (STOP, START, HELP, anything else), kept as the opt-out audit trail.
CREATE TABLE sms_events (
  id            bigserial PRIMARY KEY,
  from_number   text NOT NULL,
  body          text,
  action        text NOT NULL CHECK (action IN ('stop', 'start', 'help', 'other')),
  contacts_updated int NOT NULL DEFAULT 0,
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_mobile_idx ON contacts (mobile) WHERE mobile IS NOT NULL;
