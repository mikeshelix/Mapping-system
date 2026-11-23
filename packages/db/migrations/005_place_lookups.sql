-- Google place lookups made by the assistant. Only the count matters: it keeps monthly
-- use inside Google's free allowance. No Google content is stored, only the question asked.
CREATE TABLE place_lookups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  query text NOT NULL,
  result_count integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('ok', 'error')),
  error text,
  duration_ms integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX place_lookups_created_idx ON place_lookups (created_at);
CREATE INDEX place_lookups_org_idx ON place_lookups (organization_id, created_at);
