CREATE TABLE app.learning_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  created_by text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'closed', 'archived')),
  task_type text NOT NULL DEFAULT 'normal'
    CHECK (task_type IN ('normal', 'remedial')),
  source_task_id uuid REFERENCES app.learning_tasks(id) ON DELETE RESTRICT,
  start_at timestamptz,
  due_at timestamptz,
  completion_rule jsonb NOT NULL DEFAULT '{"version":1,"requiredScenes":"all","explicitCompletion":true}'::jsonb,
  share_token text UNIQUE,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (due_at IS NULL OR start_at IS NULL OR due_at >= start_at),
  CHECK (
    (task_type = 'normal' AND source_task_id IS NULL) OR
    (task_type = 'remedial' AND source_task_id IS NOT NULL)
  ),
  CHECK (status <> 'published' OR (share_token IS NOT NULL AND published_at IS NOT NULL))
);

CREATE INDEX learning_tasks_creator_idx
  ON app.learning_tasks (created_by, status, created_at DESC);

CREATE TABLE app.task_courses (
  task_id uuid NOT NULL REFERENCES app.learning_tasks(id) ON DELETE CASCADE,
  course_id text NOT NULL REFERENCES app.courses(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position > 0),
  is_required boolean NOT NULL DEFAULT true,
  snapshot_id uuid REFERENCES app.course_snapshots(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, course_id),
  UNIQUE (task_id, position)
);

CREATE TABLE app.task_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES app.learning_tasks(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'completed')),
  progress_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  mastery_percent numeric(5,2) CHECK (mastery_percent BETWEEN 0 AND 100),
  effective_seconds bigint NOT NULL DEFAULT 0 CHECK (effective_seconds >= 0),
  completed_scene_count integer NOT NULL DEFAULT 0 CHECK (completed_scene_count >= 0),
  total_scene_count integer NOT NULL DEFAULT 0 CHECK (total_scene_count >= completed_scene_count),
  started_at timestamptz,
  completion_requested_at timestamptz,
  completed_at timestamptz,
  last_seen_at timestamptz,
  last_scene_id text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, user_id)
);

CREATE INDEX task_assignments_user_idx
  ON app.task_assignments (user_id, status, assigned_at DESC);

CREATE TABLE app.task_course_progress (
  task_id uuid NOT NULL,
  user_id text NOT NULL,
  course_id text NOT NULL,
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'completed')),
  progress_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  effective_seconds bigint NOT NULL DEFAULT 0 CHECK (effective_seconds >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  last_seen_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id, course_id),
  FOREIGN KEY (task_id, user_id)
    REFERENCES app.task_assignments(task_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (task_id, course_id)
    REFERENCES app.task_courses(task_id, course_id) ON DELETE CASCADE
);
