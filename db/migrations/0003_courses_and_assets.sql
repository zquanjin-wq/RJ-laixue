CREATE TABLE app.courses (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
  title text NOT NULL,
  topic text,
  content jsonb NOT NULL,
  save_state text NOT NULL DEFAULT 'draft'
    CHECK (save_state IN ('draft', 'ready', 'failed')),
  content_revision bigint NOT NULL DEFAULT 1 CHECK (content_revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX courses_owner_updated_idx
  ON app.courses (owner_user_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE app.course_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id text REFERENCES app.courses(id) ON DELETE RESTRICT,
  owner_user_id text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
  kind text NOT NULL
    CHECK (kind IN ('audio', 'image', 'material', 'video', 'pbl', 'other')),
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'ready', 'deleting', 'deleted', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  bound_at timestamptz,
  deleted_at timestamptz
);

CREATE INDEX course_assets_course_idx
  ON app.course_assets (course_id, created_at)
  WHERE deleted_at IS NULL;

CREATE INDEX course_assets_owner_pending_idx
  ON app.course_assets (owner_user_id, created_at)
  WHERE state = 'pending';

CREATE TABLE app.course_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id text NOT NULL REFERENCES app.courses(id) ON DELETE RESTRICT,
  course_revision bigint NOT NULL CHECK (course_revision >= 1),
  content jsonb NOT NULL,
  created_by text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, course_revision)
);
