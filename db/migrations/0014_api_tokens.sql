CREATE TABLE app.api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  token_prefix text NOT NULL CHECK (length(token_prefix) BETWEEN 8 AND 32),
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  scopes jsonb NOT NULL DEFAULT '["classroom:write","classroom:read"]'::jsonb,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX api_tokens_owner_idx ON app.api_tokens (owner_user_id, created_at DESC);
