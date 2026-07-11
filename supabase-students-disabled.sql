-- ============================================================
-- RJ-laixue · supabase-students-disabled.sql
-- Soft-delete column for the students roster.
--
-- When an admin clicks "禁用" on /admin/students, we set
-- disabled_at = now() instead of dropping the row. The learner
-- can't log in to /student/courses any more (the page gates on
-- disabled_at IS NULL), but the historical record + assignments
-- + progress events stay intact in case the operator wants to
-- re-enable the account later.
--
-- Idempotent: safe to re-run.
-- ============================================================

alter table public.students
  add column if not exists disabled_at timestamptz;

create index if not exists idx_students_disabled_at
  on public.students (disabled_at)
  where disabled_at is null;