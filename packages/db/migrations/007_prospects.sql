-- Prospects: businesses and locations a user wants to call on, usually picked from the map
-- after a hazard. Kept apart from clients so the client list stays the list of people who
-- are actually notified. external_ref is reserved for the id of the matching record in an
-- outside sales system once one is connected.
CREATE TABLE prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT '',
  zip text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  website text NOT NULL DEFAULT '',
  lon double precision,
  lat double precision,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'business', 'property')),
  source_ref text,
  found_in text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'called', 'follow_up', 'interested', 'not_interested', 'won')),
  notes text NOT NULL DEFAULT '',
  calls integer NOT NULL DEFAULT 0,
  last_contacted_at timestamptz,
  follow_up_on date,
  external_ref text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prospects_org_idx ON prospects (organization_id, status, created_at DESC);
-- The same business or location is only ever on an organization's list once.
CREATE UNIQUE INDEX prospects_source_idx ON prospects (organization_id, source, source_ref) WHERE source_ref IS NOT NULL;
