-- Keep commit semantics (create/enhance) separate from the generation recipe.
-- Existing text jobs retain the default and continue to be claimed unchanged.
ALTER TABLE app.classroom_generation_jobs
  ADD COLUMN pipeline_kind text NOT NULL DEFAULT 'text_classroom'
  CHECK (pipeline_kind IN ('text_classroom', 'pptx_ai_classroom'));

CREATE INDEX classroom_generation_pipeline_idx
  ON app.classroom_generation_jobs (pipeline_kind, job_id);
