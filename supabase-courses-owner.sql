-- ============================================================
-- RJ-laixue · supabase-courses-owner.sql
--
-- Add created_by (course owner) column to public.courses.
-- Used by the new '发现' (browse) / '我的' (mine) split in the
-- course library: only the creator sees the edit + delete
-- affordances on a course row.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- Add the column. References auth.users so ON DELETE SET NULL
-- leaves the course in place (just unowned) if the user is deleted.
alter table public.courses
  add column if not exists created_by uuid references auth.users(id) on delete set null;

-- Index for the common "list my courses" query.
create index if not exists courses_created_by_idx
  on public.courses (created_by)
  where created_by is not null;