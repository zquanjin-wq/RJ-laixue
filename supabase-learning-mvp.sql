-- RJ-laixue learning MVP schema
-- Run this in Supabase SQL Editor after the existing courses table is ready.

create extension if not exists pgcrypto;

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  access_code text unique default upper(substring(md5(random()::text) from 1 for 6)),
  name text not null,
  email text,
  employee_no text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.students
  add column if not exists access_code text;

update public.students
set access_code = upper(substring(md5(random()::text) from 1 for 6))
where access_code is null;

alter table public.students
  alter column access_code set default upper(substring(md5(random()::text) from 1 for 6));

create unique index if not exists students_email_unique
  on public.students (email);

create unique index if not exists students_access_code_unique
  on public.students (access_code);

create unique index if not exists students_employee_no_unique
  on public.students (employee_no);

create table if not exists public.course_assignments (
  id uuid primary key default gen_random_uuid(),
  -- Keep course_id as text and do not add a hard FK to courses(id).
  -- Existing RJ-laixue deployments may have different courses.id types.
  course_id text not null,
  student_id uuid not null references public.students(id) on delete cascade,
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'completed')),
  assigned_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_seen_at timestamptz,
  due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (course_id, student_id)
);

create index if not exists course_assignments_course_id_idx
  on public.course_assignments (course_id);

create index if not exists course_assignments_student_id_idx
  on public.course_assignments (student_id);

create table if not exists public.course_progress_events (
  id uuid primary key default gen_random_uuid(),
  course_id text not null,
  student_id uuid references public.students(id) on delete set null,
  assignment_id uuid references public.course_assignments(id) on delete set null,
  event_type text not null
    check (event_type in ('open_course', 'view_scene', 'complete_course')),
  scene_id text,
  scene_order integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists course_progress_events_course_id_idx
  on public.course_progress_events (course_id, created_at desc);

create index if not exists course_progress_events_student_id_idx
  on public.course_progress_events (student_id, created_at desc);

-- RLS policies: allow anon key full access to learning tables
alter table public.students enable row level security;
alter table public.course_assignments enable row level security;
alter table public.course_progress_events enable row level security;

create policy "Allow anon read students" on public.students for select to anon using (true);
create policy "Allow anon insert students" on public.students for insert to anon with check (true);
create policy "Allow anon update students" on public.students for update to anon using (true) with check (true);

create policy "Allow anon read assignments" on public.course_assignments for select to anon using (true);
create policy "Allow anon insert assignments" on public.course_assignments for insert to anon with check (true);
create policy "Allow anon update assignments" on public.course_assignments for update to anon using (true) with check (true);

create policy "Allow anon read events" on public.course_progress_events for select to anon using (true);
create policy "Allow anon insert events" on public.course_progress_events for insert to anon with check (true);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_students_updated_at on public.students;
create trigger touch_students_updated_at
before update on public.students
for each row execute function public.touch_updated_at();

drop trigger if exists touch_course_assignments_updated_at on public.course_assignments;
create trigger touch_course_assignments_updated_at
before update on public.course_assignments
for each row execute function public.touch_updated_at();
