-- A revoice job must commit against the exact course revision it was created
-- from. Timestamps are not a safe concurrency token: database precision and
-- rapid consecutive saves can make an unchanged-looking timestamp overwrite
-- newer author edits.
ALTER TABLE app.course_revoice_jobs
  ADD COLUMN IF NOT EXISTS source_revision integer;

-- Existing queued/running rows were created before a revision was captured.
-- Do not guess from the course's *current* revision: that could let an old
-- snapshot overwrite edits made while the migration was being deployed.
UPDATE app.course_revoice_jobs
SET status = 'conflict',
    message = '配音任务因系统升级需要重新发起，课程内容未被修改。',
    locked_until = NULL,
    completed_at = now(),
    updated_at = now()
WHERE source_revision IS NULL
  AND status IN ('queued', 'running');

UPDATE app.course_revoice_jobs job
SET source_revision = course.content_revision
FROM app.courses course
WHERE job.course_id = course.id
  AND job.source_revision IS NULL;

ALTER TABLE app.course_revoice_jobs
  ALTER COLUMN source_revision SET NOT NULL;
