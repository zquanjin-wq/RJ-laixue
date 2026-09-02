-- ============================================================
-- RJ-laixue · supabase-rls-tighten-wave2.sql
--
-- Wave 2: enable RLS on public.courses + restrict to SELECT-only
-- for anon and authenticated. Writes (INSERT / UPDATE / DELETE)
-- must go through /api/courses/* which now uses service_role.
--
-- Client-side code (lib/utils/cloud-sync.ts) that reads courses
-- via the anon browser client still works because we grant
-- SELECT to anon. Only writes are blocked at the database level.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- Enable RLS on courses table (was previously un-RLS'd — anyone
-- with the anon key could read AND write freely).
alter table public.courses enable row level security;

-- Allow anon + authenticated SELECT (client-side reads from
-- cloud-sync.ts listCloudCourses / importCourseFromCloud).
drop policy if exists "Allow anon read courses" on public.courses;
create policy "Allow anon read courses"
  on public.courses for select
  to anon using (true);

drop policy if exists "Allow authenticated read courses" on public.courses;
create policy "Allow authenticated read courses"
  on public.courses for select
  to authenticated using (true);

-- No INSERT / UPDATE / DELETE policies for anon or authenticated.
-- service_role bypasses RLS, so /api/courses/* (which uses
-- service_role) can still write. Client-side direct writes are
-- blocked at the DB level.

-- Verification.
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'courses'
order by cmd, policyname;