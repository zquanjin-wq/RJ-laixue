-- Add background-export progress fields to an existing Preview installation.
-- Structure only: execute separately after review.

alter table public.course_video_export_jobs
  add column if not exists progress_current integer,
  add column if not exists progress_total integer,
  add column if not exists source_label text;
