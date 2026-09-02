-- ============================================================
-- RJ-laixue · supabase-rls-tighten-wave1.sql
--
-- Wave 1 of the RLS tightening series: revoke anon WRITE on the
-- learning tables. Wave 2+ will move the OPENMAIC upstream API
-- routes from anon to service_role so they continue to work.
--
-- Why this wave is safe for RJ-laixue even though it breaks
-- upstream's anon API:
--   - admin student creation     -> POST /api/admin/students/create (service_role)
--   - admin teacher creation     -> POST /api/admin/teachers/create (service_role)
--   - admin disable / enable     -> service_role
--   - learner course listing     -> /student/courses reads courses via anon (read-only)
--   - cloud-courses roster       -> listCloudCourses() reads via anon (read-only)
-- So the only thing that loses writes is the OPENMAIC upstream
-- authoring surface (lib/utils/cloud-sync.ts saveStageToCloud and
-- friends) — and that's exactly what the wave 2 / wave 3 route
-- rewires to service_role.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- students: revoke anon insert + update
drop policy if exists "Allow anon insert students" on public.students;
drop policy if exists "Allow anon update students" on public.students;

-- course_assignments: revoke anon insert + update
drop policy if exists "Allow anon insert assignments" on public.course_assignments;
drop policy if exists "Allow anon update assignments" on public.course_assignments;

-- course_progress_events: revoke anon insert + update (the
-- migration already created read + insert; some forks also had
-- an update policy we drop defensively).
drop policy if exists "Allow anon insert events" on public.course_progress_events;
drop policy if exists "Allow anon update events" on public.course_progress_events;

-- Verification: confirm only SELECT (anon read) policies remain
-- on these three tables. service_role bypasses RLS, so admins and
-- RJ-laixue's service-role routes keep working without further grants.
select
  tablename,
  policyname,
  cmd,
  roles,
  qual
from pg_policies
where schemaname = 'public'
  and tablename in ('students', 'course_assignments', 'course_progress_events')
order by tablename, cmd, policyname;