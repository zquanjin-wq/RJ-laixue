-- A revoice job must commit against the exact course revision it was created
-- from. Timestamps are not a safe concurrency token: database precision and
-- rapid consecutive saves can make an unchanged-looking timestamp overwrite
-- newer author edits.
ALTER TABLE app.course_revoice_jobs
  ADD COLUMN IF NOT EXISTS source_revision integer;

UPDATE app.course_revoice_jobs job
SET source_revision = course.content_revision
FROM app.courses course
WHERE job.course_id = course.id
  AND job.source_revision IS NULL;

ALTER TABLE app.course_revoice_jobs
  ALTER COLUMN source_revision SET NOT NULL;
