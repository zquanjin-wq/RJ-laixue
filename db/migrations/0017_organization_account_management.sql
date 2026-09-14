CREATE TABLE app.organization_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  parent_id uuid REFERENCES app.organization_units(id) ON DELETE RESTRICT,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (parent_id, name)
);

ALTER TABLE app.user_profiles
  ADD COLUMN organization_unit_id uuid REFERENCES app.organization_units(id) ON DELETE SET NULL;

CREATE INDEX user_profiles_organization_unit_idx
  ON app.user_profiles (organization_unit_id);

CREATE TABLE app.account_management_grants (
  user_id text PRIMARY KEY REFERENCES app.user_profiles(user_id) ON DELETE CASCADE,
  organization_unit_id uuid NOT NULL REFERENCES app.organization_units(id) ON DELETE RESTRICT,
  include_descendants boolean NOT NULL DEFAULT true,
  granted_by text NOT NULL REFERENCES app.user_profiles(user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX account_management_grants_org_idx
  ON app.account_management_grants (organization_unit_id)
  WHERE revoked_at IS NULL;

CREATE TABLE app.account_audit_events (
  id bigserial PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES app.user_profiles(user_id) ON DELETE RESTRICT,
  target_user_id text REFERENCES app.user_profiles(user_id) ON DELETE SET NULL,
  action text NOT NULL,
  organization_unit_id uuid REFERENCES app.organization_units(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX account_audit_events_created_idx
  ON app.account_audit_events (created_at DESC);
CREATE INDEX account_audit_events_actor_idx
  ON app.account_audit_events (actor_user_id, created_at DESC);
