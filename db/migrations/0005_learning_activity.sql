CREATE TABLE app.learning_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  user_id text NOT NULL,
  course_id text,
  session_key text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'abandoned')),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  effective_seconds bigint NOT NULL DEFAULT 0 CHECK (effective_seconds >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, user_id, session_key),
  FOREIGN KEY (task_id, user_id)
    REFERENCES app.task_assignments(task_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (task_id, course_id)
    REFERENCES app.task_courses(task_id, course_id) ON DELETE RESTRICT
);

CREATE INDEX learning_attempts_assignment_idx
  ON app.learning_attempts (task_id, user_id, started_at DESC);

CREATE TABLE app.learning_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES app.learning_attempts(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  user_id text NOT NULL,
  course_id text,
  client_event_id text NOT NULL,
  event_type text NOT NULL,
  scene_id text,
  scene_order integer,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, user_id, client_event_id),
  FOREIGN KEY (task_id, user_id)
    REFERENCES app.task_assignments(task_id, user_id) ON DELETE CASCADE
);

CREATE INDEX learning_events_attempt_idx
  ON app.learning_events (attempt_id, received_at);

CREATE INDEX learning_events_assignment_idx
  ON app.learning_events (task_id, user_id, received_at DESC);
