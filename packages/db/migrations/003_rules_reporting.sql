-- Phase 3: rule builder and reporting.

-- Rules can now also cover ZIP codes.
ALTER TABLE alert_rules DROP CONSTRAINT alert_rules_scope_check;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_scope_check
  CHECK (scope IN ('all', 'clients', 'properties', 'zips'));

CREATE TABLE alert_rule_zips (
  rule_id  uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  zip      text NOT NULL CHECK (zip ~ '^[0-9]{5}$'),
  PRIMARY KEY (rule_id, zip)
);

-- Which template a rule was started from, for display only.
ALTER TABLE alert_rules ADD COLUMN template text;

-- Rule preview replays stored events by when they were first seen.
CREATE INDEX hazard_events_first_seen_geom_idx ON hazard_events (first_seen_at) WHERE geometry IS NOT NULL;
