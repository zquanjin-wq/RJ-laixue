-- ============================================================
-- RJ-laixue · supabase-rls-tighten-wave5.sql
--
-- Wave 5 (final): drop ALL remaining anon SELECT policies.
-- After this, the anon key can do NOTHING on any learning table.
-- All reads and writes go through /api/* routes which use
-- service_role (bypasses RLS).
--
-- Prerequisites:
--   Wave 1 (supabase-rls-tighten-wave1.sql) — revoked anon writes
--   Wave 2 (supabase-rls-tighten-wave2.sql) — enabled RLS on courses
--   Wave 3-4 (code changes) — all API routes + cloud-sync.ts
--            switched from anon client to service_role / fetch API
--
-- Idempotent: safe to re-run.
-- ============================================================

-- students: drop last anon policy (SELECT)
drop policy if exists "Allow anon read students" on public.students;

-- course_assignments: drop last anon policy (SELECT)
drop policy if exists "Allow anon read assignments" on public.course_assignments;

-- course_progress_events: drop last anon policy (SELECT)
drop policy if exists "Allow anon read events" on public.course_progress_events;

-- courses: drop anon SELECT (Wave 2 added it; now redundant since
-- cloud-sync.ts reads via /api/courses which uses service_role)
drop policy if exists "Allow anon read courses" on public.courses;

-- Verification: anon should have ZERO policies remaining.
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('students', 'course_assignments', 'course_progress_events', 'courses')
  and 'anon' = any(roles::text[])
order by tablename;