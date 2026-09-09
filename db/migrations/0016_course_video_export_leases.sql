-- Video exports are executed by independently deployable render agents.  A
-- lease makes a queued job safe to claim from more than one agent and lets a
-- replacement agent recover work after a host disappears.
ALTER TABLE app.course_video_exports
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS worker_lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS course_video_exports_claim_idx
  ON app.course_video_exports (status, worker_lease_expires_at, created_at)
  WHERE status IN ('queued', 'running');
