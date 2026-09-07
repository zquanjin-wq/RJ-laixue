CREATE TABLE app.classroom_generation_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL UNIQUE REFERENCES app.course_assets(id) ON DELETE RESTRICT,
  source_kind text NOT NULL CHECK (source_kind IN ('pptx')),
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'parsed', 'failed')),
  content_hash text,
  parser_version text,
  import_result jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX classroom_generation_sources_owner_idx
  ON app.classroom_generation_sources (owner_user_id, created_at DESC);
