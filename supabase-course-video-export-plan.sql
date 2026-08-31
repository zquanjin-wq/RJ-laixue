-- Preview follow-up: persist the page plan shown in the video export center.
alter table public.course_video_export_jobs
  add column if not exists export_plan jsonb;
