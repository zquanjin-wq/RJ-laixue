-- Gate 2B: publish a task course package and track each learner's course progress.

create table if not exists public.task_course_progress (
  task_id uuid not null references public.learning_tasks(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  course_id text not null references public.courses(id),
  status text not null default 'not_started' check (status in ('not_started', 'in_progress', 'completed')),
  progress_percent numeric not null default 0 check (progress_percent >= 0 and progress_percent <= 100),
  effective_seconds integer not null default 0 check (effective_seconds >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  last_seen_at timestamptz,
  primary key (task_id, student_id, course_id)
);

create index if not exists task_course_progress_task_course_idx on public.task_course_progress(task_id, course_id);
alter table public.task_course_progress enable row level security;
revoke all on public.task_course_progress from anon, authenticated;

-- Keep old tasks and learners added after publication compatible with the package model.
insert into public.task_course_progress(task_id, student_id, course_id, status, progress_percent, effective_seconds, started_at, completed_at, last_seen_at)
select tl.task_id, tl.student_id, tc.course_id, tl.status, tl.progress_percent, tl.effective_seconds, tl.started_at, tl.completed_at, tl.last_seen_at
from public.task_learners tl join public.task_courses tc on tc.task_id = tl.task_id
on conflict do nothing;

create or replace function public.create_task_course_progress_for_learner()
returns trigger as $$
begin
  insert into public.task_course_progress(task_id, student_id, course_id)
  select new.task_id, new.student_id, course_id
  from public.task_courses where task_id = new.task_id
  on conflict do nothing;
  return new;
end;
$$ language plpgsql;

drop trigger if exists create_task_course_progress_on_assignment on public.task_learners;
create trigger create_task_course_progress_on_assignment
after insert on public.task_learners
for each row execute function public.create_task_course_progress_for_learner();

alter table public.task_learning_events add column if not exists course_id text references public.courses(id);
create index if not exists task_learning_events_task_course_student_idx on public.task_learning_events(task_id, course_id, student_id, created_at);

create or replace function public.publish_task_course_package(p_task_id uuid, p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_task record; v_item record; v_roster integer; v_token text; v_primary_snapshot uuid;
begin
  select * into v_task from public.learning_tasks where id = p_task_id for update;
  if not found then raise exception 'TASK_NOT_FOUND' using errcode = 'P0030'; end if;
  if v_task.created_by <> p_user_id then raise exception 'TASK_NOT_OWNED' using errcode = 'P0031'; end if;
  if v_task.status = 'published' then return jsonb_build_object('task_id', v_task.id, 'status', v_task.status, 'share_token', v_task.share_token, 'published', true); end if;
  if v_task.status <> 'draft' then raise exception 'Only draft task can be published' using errcode = 'P0032'; end if;
  select count(*) into v_roster from public.task_learners where task_id = p_task_id;
  if v_roster = 0 then raise exception 'TASK_EMPTY_ROSTER' using errcode = 'P0033'; end if;
  for v_item in select tc.*, c.data from public.task_courses tc join public.courses c on c.id = tc.course_id where tc.task_id = p_task_id order by tc.position loop
    insert into public.course_snapshots(course_id, source_hash, snapshot_data, created_by)
    values(v_item.course_id, 'task:' || p_task_id::text || ':course:' || v_item.course_id, v_item.data, p_user_id)
    on conflict(course_id, source_hash) do nothing;
    update public.task_courses set snapshot_id = (select id from public.course_snapshots where course_id = v_item.course_id and source_hash = 'task:' || p_task_id::text || ':course:' || v_item.course_id) where task_id = p_task_id and course_id = v_item.course_id;
  end loop;
  select snapshot_id into v_primary_snapshot from public.task_courses where task_id = p_task_id order by position limit 1;
  v_token := encode(gen_random_bytes(16), 'hex');
  update public.learning_tasks set status = 'published', snapshot_id = v_primary_snapshot, share_token = v_token, published_at = now() where id = p_task_id;
  insert into public.task_course_progress(task_id, student_id, course_id)
  select tl.task_id, tl.student_id, tc.course_id from public.task_learners tl join public.task_courses tc on tc.task_id = tl.task_id where tl.task_id = p_task_id
  on conflict do nothing;
  return jsonb_build_object('task_id', p_task_id, 'status', 'published', 'share_token', v_token, 'published', true);
end;
$$;

revoke execute on function public.publish_task_course_package(uuid, uuid) from public, anon, authenticated;
grant execute on function public.publish_task_course_package(uuid, uuid) to service_role;
