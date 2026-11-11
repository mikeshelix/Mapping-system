-- Phase 4: assistant usage metering and area (draw-a-shape) searches.

-- One row per question put to the assistant, with what it cost. This is the
-- basis for per-transaction pricing of AI-assisted searches.
CREATE TABLE assistant_usage (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  question            text NOT NULL,
  model               text NOT NULL,
  status              text NOT NULL CHECK (status IN ('ok', 'error', 'refused', 'incomplete')),
  requests            int NOT NULL DEFAULT 0,
  tool_calls          int NOT NULL DEFAULT 0,
  input_tokens        int NOT NULL DEFAULT 0,
  output_tokens       int NOT NULL DEFAULT 0,
  cache_read_tokens   int NOT NULL DEFAULT 0,
  cache_write_tokens  int NOT NULL DEFAULT 0,
  -- Estimated from the published price list at the time of the question; NULL when the model's price is not known.
  cost_usd            numeric(12, 6),
  duration_ms         int NOT NULL DEFAULT 0,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_usage_org_created_idx ON assistant_usage (organization_id, created_at);
CREATE INDEX assistant_usage_created_idx ON assistant_usage (created_at);

-- One row per business search inside a drawn area.
CREATE TABLE area_searches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  area             geometry(Polygon, 4326) NOT NULL,
  category         text NOT NULL,
  source           text NOT NULL,
  result_count     int NOT NULL DEFAULT 0,
  status           text NOT NULL CHECK (status IN ('ok', 'error')),
  error            text,
  duration_ms      int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX area_searches_org_created_idx ON area_searches (organization_id, created_at);
