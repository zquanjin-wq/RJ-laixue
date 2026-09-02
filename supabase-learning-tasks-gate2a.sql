-- Gate 2A: a learning task can contain an ordered course package.
-- Existing single-course tasks are retained as one-item packages.

create table if not exists public.task_courses (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.learning_tasks(id) on delete cascade,
  course_id text not null references public.courses(id),
  position integer not null default 1 check (position > 0),
  is_required boolean not null default true,
  snapshot_id uuid references public.course_snapshots(id),
  created_at timestamptz not null default now(),
  unique(task_id, course_id),
  unique(task_id, position)
);

create index if not exists task_courses_task_position_idx on public.task_courses(task_id, position);
create index if not exists task_courses_course_idx on public.task_courses(course_id);

-- Backfill every existing task as a one-course package. Safe to rerun.
insert into public.task_courses (task_id, course_id, position, is_required, snapshot_id)
select id, course_id, 1, true, snapshot_id
from public.learning_tasks
on conflict (task_id, course_id) do nothing;

alter table public.task_courses enable row level security;
revoke all on public.task_courses from anon, authenticated;

create or replace function public.check_task_courses_frozen()
returns trigger as $$
declare v_status text;
begin
  select status into v_status
  from public.learning_tasks
  where id = case when tg_op = 'DELETE' then old.task_id else new.task_id end;
  if v_status is not null and v_status <> 'draft' then
    raise exception 'course package cannot be changed after publish';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$ language plpgsql;

drop trigger if exists enforce_task_courses_frozen on public.task_courses;
create trigger enforce_task_courses_frozen
before insert or update or delete on public.task_courses
for each row execute function public.check_task_courses_frozen();

create or replace function public.replace_task_courses(
  p_task_id uuid,
  p_course_ids text[]
)
returns void
language plpgsql security definer set search_path = public as $$
declare v_status text; v_count integer;
begin
  select status into v_status from public.learning_tasks where id = p_task_id for update;
  if v_status is null then raise exception 'Task not found' using errcode = 'P0020'; end if;
  if v_status <> 'draft' then raise exception 'Only draft task course package can be changed' using errcode = 'P0021'; end if;
  if coalesce(array_length(p_course_ids, 1), 0) = 0 then raise exception 'At least one course is required' using errcode = 'P0022'; end if;
  if (select count(distinct id) from public.courses where id = any(p_course_ids)) <> array_length(p_course_ids, 1) then
    raise exception 'One or more courses do not exist' using errcode = 'P0023';
  end if;
  delete from public.task_courses where task_id = p_task_id;
  insert into public.task_courses (task_id, course_id, position)
  select p_task_id, course_id, ordinal::integer
  from unnest(p_course_ids) with ordinality as courses(course_id, ordinal);
  update public.learning_tasks set course_id = p_course_ids[1] where id = p_task_id;
end;
$$;

revoke execute on function public.replace_task_courses(uuid, text[]) from public, anon, authenticated;
grant execute on function public.replace_task_courses(uuid, text[]) to service_role;
