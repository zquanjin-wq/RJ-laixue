-- Durable video export jobs. Apply after the existing courses schema.
-- This file defines structure only; it is not executed by the application.

create table if not exists public.course_video_export_jobs (
  id text primary key,
  course_id text not null references public.courses(id) on delete cascade,
  requested_by text not null,
  status text not null check (status in ('uploading', 'queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input_path text not null,
  output_path text,
  render_job_id text,
  message text not null default '',
  error text,
  progress_current integer,
  progress_total integer,
  source_label text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists course_video_export_jobs_course_idx
  on public.course_video_export_jobs (course_id, created_at desc);
create index if not exists course_video_export_jobs_owner_idx
  on public.course_video_export_jobs (requested_by, created_at desc);

alter table public.course_video_export_jobs enable row level security;

drop policy if exists "Owners can read their video export jobs" on public.course_video_export_jobs;
create policy "Owners can read their video export jobs"
  on public.course_video_export_jobs for select
  using (auth.uid()::text = requested_by);
