CREATE TABLE app.course_video_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id text NOT NULL REFERENCES app.courses(id) ON DELETE RESTRICT,
  requested_by text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  request jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_bucket text,
  output_object_key text,
  output_content_type text,
  output_size_bytes bigint CHECK (output_size_bytes >= 0),
  output_etag text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (output_bucket IS NULL AND output_object_key IS NULL AND output_content_type IS NULL
      AND output_size_bytes IS NULL AND output_etag IS NULL)
    OR
    (output_bucket IS NOT NULL AND output_object_key IS NOT NULL AND output_content_type IS NOT NULL
      AND output_size_bytes IS NOT NULL)
  ),
  CHECK (
    (status = 'succeeded' AND output_object_key IS NOT NULL)
    OR (status <> 'succeeded' AND output_object_key IS NULL)
  )
);

CREATE INDEX course_video_exports_course_created_idx
  ON app.course_video_exports (course_id, created_at DESC);

CREATE INDEX course_video_exports_runnable_idx
  ON app.course_video_exports (created_at)
  WHERE status IN ('queued', 'running');
