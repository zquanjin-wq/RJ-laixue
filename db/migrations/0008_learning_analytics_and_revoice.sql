CREATE TABLE IF NOT EXISTS app.ai_learning_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES app.learning_tasks(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('class', 'learner')),
  user_id text REFERENCES public."user"(id) ON DELETE SET NULL,
  content jsonb NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  data_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'class' AND user_id IS NULL) OR (scope = 'learner' AND user_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ai_learning_summaries_task_created_idx
  ON app.ai_learning_summaries (task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app.ai_intervention_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES app.learning_tasks(id) ON DELETE CASCADE,
  scene_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
  created_task_id uuid REFERENCES app.learning_tasks(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_intervention_suggestions_task_created_idx
  ON app.ai_intervention_suggestions (task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app.ai_intervention_targets (
  suggestion_id uuid NOT NULL REFERENCES app.ai_intervention_suggestions(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
  PRIMARY KEY (suggestion_id, user_id)
);

CREATE TABLE IF NOT EXISTS app.course_revoice_jobs (
  id text PRIMARY KEY,
  course_id text NOT NULL REFERENCES app.courses(id) ON DELETE CASCADE,
  requested_by text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'conflict')),
  voice jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  source_updated_at timestamptz NOT NULL,
  items jsonb NOT NULL,
  total_items integer NOT NULL CHECK (total_items >= 0),
  completed_items integer NOT NULL DEFAULT 0 CHECK (completed_items >= 0),
  failed_items integer NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
  message text NOT NULL,
  error text,
  locked_until timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS course_revoice_jobs_one_active_per_course
  ON app.course_revoice_jobs (course_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS course_revoice_jobs_runnable_idx
  ON app.course_revoice_jobs (created_at)
  WHERE status IN ('queued', 'running');
