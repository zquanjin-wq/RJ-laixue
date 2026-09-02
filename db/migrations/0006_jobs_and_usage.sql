CREATE TABLE app.background_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  owner_user_id text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
  resource_type text,
  resource_id text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'conflict')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  error_code text,
  error_message text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_until timestamptz,
  source_revision text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX background_jobs_claim_idx
  ON app.background_jobs (run_after, created_at)
  WHERE status = 'queued';

CREATE TABLE app.usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text REFERENCES public."user"(id) ON DELETE SET NULL,
  request_id text,
  event_key text UNIQUE,
  kind text NOT NULL,
  source text NOT NULL,
  provider text,
  model text,
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  quantity numeric CHECK (quantity >= 0),
  unit text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX usage_events_created_idx ON app.usage_events (created_at DESC);
CREATE INDEX usage_events_user_idx ON app.usage_events (user_id, created_at DESC);
