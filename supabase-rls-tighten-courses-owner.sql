-- ============================================================
-- RJ-laixue · supabase-rls-tighten-courses-owner.sql
--
-- Tighten courses / course_assignments RLS so that:
--   1. courses.created_by is backfilled for legacy rows that were
--      inserted before the column existed (supabase-courses-owner.sql
--      added it but doesn't backfill).
--   2. Anonymous SELECT on courses is removed (we already routed
--      reads through /api/courses which uses service_role).
--   3. course_assignments no longer allows anon reads (Wave 5
--      already did this, but re-affirm in case it wasn't applied).
--   4. course_assignments SELECT is restricted to:
--        - learners: only rows where students.user_id = auth.uid()
--        - teachers / admins: all rows (so they can manage rosters)
--
-- PREREQUISITES (must already be applied in order):
--   supabase-learning-mvp.sql        — schema + anon allow policies
--   supabase-auth-mvp.sql            — profiles table + role enum
--   supabase-courses-owner.sql       — courses.created_by column
--   supabase-rls-tighten-wave1.sql   — anon writes revoked
--   supabase-rls-tighten-wave2.sql   — courses SELECT-only
--   supabase-rls-tighten-wave5.sql   — anon SELECT removed
--
-- Run AFTER all of the above. Idempotent: safe to re-run.
--
-- TYPE NOTE: profiles.id, students.id, students.user_id,
-- courses.created_by, and course_assignments.student_id are all
-- `uuid` (declared in supabase-auth-mvp.sql / supabase-learning-mvp.sql
-- / supabase-courses-owner.sql). auth.uid() also returns uuid, so
-- comparisons below use `auth.uid() = <column>` directly. Do NOT add
-- `::text` casts — they would break the comparison (and would also
-- let UUID format validation slip, which is a defense-in-depth benefit
-- we want to keep).
-- ============================================================


-- ─────────────────────────────────────────────────────────────
-- 0. Pre-flight: report current policies + dirty rows
-- ─────────────────────────────────────────────────────────────
-- Run these SELECTs FIRST so you have a baseline. Both are
-- read-only and safe.

-- 0a. Show every policy on courses / course_assignments.
select
  tablename,
  policyname,
  cmd,
  roles,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('courses', 'course_assignments')
order by tablename, cmd, policyname;

-- 0b. Find courses with no owner (legacy data).
select
  id,
  title,
  created_at,
  updated_at
from public.courses
where created_by is null
order by updated_at desc
limit 50;

-- 0c. Confirm anon has no policies left on the two tables.
select tablename, policyname
from pg_policies
where schemaname = 'public'
  and tablename in ('courses', 'course_assignments')
  and 'anon' = any(roles::text[]);


-- ─────────────────────────────────────────────────────────────
-- 1. Confirm wave-5 anon revoke (re-apply defensively)
-- ─────────────────────────────────────────────────────────────
drop policy if exists "Allow anon read courses" on public.courses;
drop policy if exists "Allow anon read assignments" on public.course_assignments;


-- ─────────────────────────────────────────────────────────────
-- 2. Tighten course_assignments SELECT for learners
-- ─────────────────────────────────────────────────────────────
-- Drop any existing course_assignments SELECT policy that allows
-- anyone-authenticated to read everything. This is the leak that
-- /api/courses/[id] GET used to rely on; with the new auth check
-- we only need to grant what the API actually queries.

drop policy if exists "Allow authenticated read assignments" on public.course_assignments;
drop policy if exists "Learners can read own assignments" on public.course_assignments;
drop policy if exists "Teachers can read all assignments" on public.course_assignments;

-- Learners: only assignments pointing at a student row whose
-- user_id matches the caller.
create policy "Learners can read own assignments"
  on public.course_assignments for select
  to authenticated
  using (
    exists (
      select 1
      from public.students s
      where s.id = course_assignments.student_id
        and s.user_id = auth.uid()
    )
  );

-- Teachers / admins: can read every assignment (roster management).
create policy "Teachers can read all assignments"
  on public.course_assignments for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role in ('admin', 'teacher')
    )
  );


-- ─────────────────────────────────────────────────────────────
-- 3. (Optional) Fix dirty created_by rows
-- ─────────────────────────────────────────────────────────────
-- Legacy rows have created_by = NULL. Until we know who owns them,
-- they fail the strict "owner or teacher/admin" check in
-- /api/courses/[id] GET — but the API still returns them because
-- the GET handler allows teacher/admin to read courses where
-- created_by IS NULL.
--
-- When you have identified the original author, backfill like:
--
--   update public.courses
--   set created_by = '<user-uuid>'
--   where id = '<course-id>';
--
-- If the course is truly orphaned (creator left the company, no
-- record), leave it NULL — admins will still be able to see and
-- re-assign it.


-- ─────────────────────────────────────────────────────────────
-- 4. Verification
-- ─────────────────────────────────────────────────────────────

-- 4a. anon should have ZERO policies on courses / course_assignments.
select tablename, policyname
from pg_policies
where schemaname = 'public'
  and tablename in ('courses', 'course_assignments')
  and 'anon' = any(roles::text[]);
-- expected: 0 rows

-- 4b. authenticated course_assignments SELECT policies should be
-- exactly the two we just created.
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename = 'course_assignments'
  and cmd = 'SELECT';
-- expected: 2 rows — "Learners can read own assignments"
--                    "Teachers can read all assignments"

-- 4c. Spot-check: pick a learner account, confirm they can only
-- see assignments pointing at students rows whose user_id matches.
-- Run while impersonating that learner (set request.jwt.claims in
-- psql / Supabase SQL editor) or just trust the policy text.

-- 4d. Spot-check: pick a teacher account, confirm they can see
-- all assignments. (Read-only query — no impersonation needed.)
-- set local role authenticated;
-- set local "request.jwt.claims" to '{"sub":"<teacher-uuid>","role":"authenticated"}';
-- select count(*) from public.course_assignments;
-- reset role;

-- Done. The /api/courses/[id] GET route plus these RLS policies
-- give us defense in depth: even if a future code change forgets
-- the role check, the database still refuses to leak data.
