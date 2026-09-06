-- Classroom generation shares the existing queue, with a dedicated execution contract.
ALTER TABLE app.background_jobs
  ADD COLUMN execution_epoch integer NOT NULL DEFAULT 0 CHECK (execution_epoch >= 0);

CREATE TABLE app.classroom_generation_jobs (
  job_id uuid PRIMARY KEY REFERENCES app.background_jobs(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('create', 'enhance')),
  channel text NOT NULL CHECK (channel IN ('web', 'skill')),
  input_kind text NOT NULL CHECK (input_kind IN ('text', 'pptx')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL,
  course_id text NOT NULL,
  source_revision integer CHECK (source_revision > 0),
  config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK ((operation = 'create' AND source_revision IS NULL)
      OR (operation = 'enhance' AND source_revision IS NOT NULL)),
  UNIQUE (owner_user_id, operation, idempotency_key)
);

CREATE TABLE app.classroom_generation_steps (
  job_id uuid NOT NULL REFERENCES app.classroom_generation_jobs(job_id) ON DELETE CASCADE,
  step_key text NOT NULL,
  input_hash text NOT NULL,
  artifact jsonb NOT NULL,
  execution_epoch integer NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, step_key)
);

CREATE INDEX classroom_generation_expired_idx ON app.background_jobs (locked_until)
  WHERE type = 'classroom-generation' AND status = 'running';
