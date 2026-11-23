-- Forecast heads-ups: an email when a location's forecast first shows weather worth
-- watching in the next two days. Off unless a rule asks for it.
ALTER TABLE alert_rules ADD COLUMN forecast_heads_up boolean NOT NULL DEFAULT false;

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('hazard', 'system', 'forecast'));

-- Which Weather Service forecast grid a point falls in. It never changes for a point, so
-- it is looked up once. forecast_url is null for points outside the United States.
CREATE TABLE forecast_grids (
  point         text PRIMARY KEY,
  forecast_url  text,
  checked_at    timestamptz NOT NULL DEFAULT now()
);

-- What each contact has already been told. The key is the guarantee that the same
-- weather, on the same day, at the same location, is only ever sent to a contact once.
CREATE TABLE forecast_heads_ups (
  contact_id       uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  property_id      uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  concern          text NOT NULL,
  forecast_day     date NOT NULL,
  notification_id  uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, property_id, concern, forecast_day)
);
CREATE INDEX forecast_heads_ups_day_idx ON forecast_heads_ups (forecast_day);
