CREATE TABLE app.classroom_generation_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES app.classroom_generation_jobs(job_id) ON DELETE CASCADE,
  execution_epoch integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('thinking', 'tool', 'result', 'warning', 'error')),
  phase text NOT NULL,
  page integer CHECK (page > 0),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX classroom_generation_events_job_idx
  ON app.classroom_generation_events (job_id, id);
