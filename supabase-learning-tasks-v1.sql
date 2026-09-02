-- ============================================================
-- RJ-laixue · supabase-learning-tasks-v1.sql
-- Gate 1A.1 修订版：基础契约修复
-- ============================================================

-- Extension schema for deterministic function resolution under empty search_path
create schema if not exists extensions;

-- 1. course_snapshots
create table if not exists public.course_snapshots (
  id            uuid primary key default gen_random_uuid(),
  course_id     text not null references public.courses(id) on delete cascade,
  source_hash   text not null,
  snapshot_data jsonb not null,
  created_by    uuid not null references auth.users(id),
  created_at    timestamptz not null default now(),
  constraint course_snapshots_course_hash_unique unique(course_id, source_hash)
);

-- 2. learning_tasks
create table if not exists public.learning_tasks (
  id              uuid primary key default gen_random_uuid(),
  course_id       text not null references public.courses(id),
  snapshot_id     uuid references public.course_snapshots(id),
  title           text not null,
  description     text,
  created_by      uuid not null references auth.users(id),
  status          text not null default 'draft'
                    check (status in ('draft', 'published', 'closed', 'archived')),
  task_type       text not null default 'normal'
                    check (task_type in ('normal', 'remedial')),
  source_task_id  uuid references public.learning_tasks(id),
  start_at        timestamptz,
  due_at          timestamptz,
  completion_rule jsonb not null default '{"version":1,"requiredScenes":"all","requiredChecks":"submitted_and_reviewed","explicitCompletion":true}'::jsonb,
  share_token     text unique,
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint learning_tasks_published_check check (status <> 'published' or (snapshot_id is not null and share_token is not null and published_at is not null)),
  constraint learning_tasks_draft_no_published_at check (status <> 'draft' or published_at is null),
  constraint learning_tasks_time_range check (due_at is null or start_at is null or due_at >= start_at),
  -- normal：没有 source_task_id；remedial：必须有 source_task_id
  constraint learning_tasks_type_source_check check (
    (task_type = 'normal' and source_task_id is null) or (task_type = 'remedial' and source_task_id is not null)
  ),
  constraint learning_tasks_token_length check (share_token is null or length(share_token) >= 16)
);

-- indexes
create index if not exists learning_tasks_created_by_idx on public.learning_tasks(created_by, status, created_at desc);
create index if not exists learning_tasks_course_id_idx on public.learning_tasks(course_id, created_at desc);

-- 3. task_learners
create table if not exists public.task_learners (
  id                    uuid primary key default gen_random_uuid(),
  task_id               uuid not null references public.learning_tasks(id) on delete cascade,
  student_id            uuid not null references public.students(id),
  status                text not null default 'not_started' check (status in ('not_started', 'in_progress', 'completed')),
  progress_percent      numeric not null default 0 check (progress_percent >= 0 and progress_percent <= 100),
  completed_scene_count integer not null default 0 check (completed_scene_count >= 0),
  total_scene_count     integer not null default 0 check (total_scene_count >= 0),
  effective_seconds     integer not null default 0 check (effective_seconds >= 0),
  started_at            timestamptz,
  completed_at          timestamptz,
  last_seen_at          timestamptz,
  last_scene_id         text,
  assigned_at           timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique(task_id, student_id),
  check (completed_scene_count <= total_scene_count)
);

create index if not exists task_learners_student_task_idx on public.task_learners(student_id, task_id);

-- ============================================================
-- Triggers
-- ============================================================

-- immutable snapshots
create or replace function public.prevent_snapshot_modification()
returns trigger as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'course_snapshots are immutable and cannot be updated';
  elsif tg_op = 'DELETE' then
    raise exception 'course_snapshots are immutable and cannot be deleted';
  end if;
end;
$$ language plpgsql;

do $$ declare r record; begin
  select oid into r from pg_class where relname = 'course_snapshots' and relnamespace = 'public'::regnamespace;
  if found and not exists (select 1 from pg_trigger where tgrelid = r.oid and tgname = 'prevent_snapshot_update') then
    create trigger prevent_snapshot_update before update on public.course_snapshots for each row execute function public.prevent_snapshot_modification();
  end if;
  if found and not exists (select 1 from pg_trigger where tgrelid = r.oid and tgname = 'prevent_snapshot_delete') then
    create trigger prevent_snapshot_delete before delete on public.course_snapshots for each row execute function public.prevent_snapshot_modification();
  end if;
end $$;

-- task immutability + state machine
create or replace function public.check_learning_tasks_immutability()
returns trigger as $$
begin
  -- Validate state-machine edges only when the status actually changes.
  -- Ordinary draft edits and permitted non-status updates must not be
  -- mistaken for state transitions.
  if new.status is distinct from old.status then
    if old.status = 'draft' and new.status not in ('published', 'archived') then
      raise exception 'draft can only transition to published or archived';
    end if;
    if old.status = 'published' and new.status not in ('closed', 'archived') then
      raise exception 'published can only transition to closed or archived';
    end if;
    if old.status = 'closed' and new.status <> 'archived' then
      raise exception 'closed can only transition to archived';
    end if;
    if old.status = 'archived' then
      raise exception 'archived tasks cannot change status';
    end if;
  end if;
  -- published+ tasks: no mutable key fields
  if old.status <> 'draft' then
    if new.course_id is distinct from old.course_id then raise exception 'course_id cannot be changed after publish'; end if;
    if new.snapshot_id is distinct from old.snapshot_id then raise exception 'snapshot_id cannot be changed after publish'; end if;
    if new.created_by is distinct from old.created_by then raise exception 'created_by cannot be changed after publish'; end if;
    if new.task_type is distinct from old.task_type then raise exception 'task_type cannot be changed after publish'; end if;
    if new.source_task_id is distinct from old.source_task_id then raise exception 'source_task_id cannot be changed after publish'; end if;
    if new.share_token is distinct from old.share_token then raise exception 'share_token cannot be changed after publish'; end if;
    if new.published_at is distinct from old.published_at then raise exception 'published_at cannot be changed after publish'; end if;
  end if;
  return new;
end;
$$ language plpgsql;

do $$ declare r record; begin
  select oid into r from pg_class where relname = 'learning_tasks' and relnamespace = 'public'::regnamespace;
  if found and not exists (select 1 from pg_trigger where tgrelid = r.oid and tgname = 'enforce_learning_tasks_immutability') then
    create trigger enforce_learning_tasks_immutability before update on public.learning_tasks for each row execute function public.check_learning_tasks_immutability();
  end if;
end $$;

-- learner roster freeze
create or replace function public.check_task_learners_frozen()
returns trigger as $$
declare t_status text;
begin
  if tg_op = 'INSERT' or tg_op = 'DELETE' then
    select status into t_status from public.learning_tasks where id = case when tg_op = 'INSERT' then new.task_id else old.task_id end;
    if t_status is null then return null; end if;
    if t_status <> 'draft' then
      raise exception 'Cannot modify learners of a non-draft task (current: %)', t_status;
    end if;
  end if;
  if tg_op = 'INSERT' then return new; else return old; end if;
end;
$$ language plpgsql;

do $$ declare r record; begin
  select oid into r from pg_class where relname = 'task_learners' and relnamespace = 'public'::regnamespace;
  if found and not exists (select 1 from pg_trigger where tgrelid = r.oid and tgname = 'enforce_task_learners_frozen') then
    create trigger enforce_task_learners_frozen before insert or delete on public.task_learners for each row execute function public.check_task_learners_frozen();
  end if;
end $$;

-- updated_at
create or replace function public.touch_task_updated_at() returns trigger as $$ begin new.updated_at = now(); return new; end; $$ language plpgsql;

do $$ declare r record; begin
  select oid into r from pg_class where relname = 'learning_tasks' and relnamespace = 'public'::regnamespace;
  if found and not exists (select 1 from pg_trigger where tgrelid = r.oid and tgname = 'touch_learning_tasks_updated_at') then
    create trigger touch_learning_tasks_updated_at before update on public.learning_tasks for each row execute function public.touch_task_updated_at();
  end if;
  select oid into r from pg_class where relname = 'task_learners' and relnamespace = 'public'::regnamespace;
  if found and not exists (select 1 from pg_trigger where tgrelid = r.oid and tgname = 'touch_task_learners_updated_at') then
    create trigger touch_task_learners_updated_at before update on public.task_learners for each row execute function public.touch_task_updated_at();
  end if;
end $$;

-- ============================================================
-- RLS
-- ============================================================

alter table public.course_snapshots enable row level security;
alter table public.learning_tasks enable row level security;
alter table public.task_learners enable row level security;

revoke all on public.course_snapshots from anon;
revoke all on public.learning_tasks from anon;
revoke all on public.task_learners from anon;

revoke insert, update, delete on public.course_snapshots from authenticated;
revoke insert, update, delete on public.learning_tasks from authenticated;
revoke insert, update, delete on public.task_learners from authenticated;

-- no select policy for course_snapshots (server-only)

drop policy if exists "Authenticated can read own published tasks" on public.learning_tasks;
create policy "Authenticated can read own published tasks" on public.learning_tasks for select to authenticated using (
  status = 'published' and exists (
    select 1 from public.task_learners tl inner join public.students s on s.id = tl.student_id
    where tl.task_id = learning_tasks.id and s.user_id = auth.uid()
  )
);

drop policy if exists "Authenticated can read own learner records" on public.task_learners;
create policy "Authenticated can read own learner records" on public.task_learners for select to authenticated using (
  exists (select 1 from public.students s where s.id = task_learners.student_id and s.user_id = auth.uid())
);

-- ============================================================
-- RPC: create_task_with_learners
-- ============================================================
create or replace function public.create_task_with_learners(
  p_course_id text, p_title text, p_description text default null,
  p_created_by uuid default auth.uid(), p_task_type text default 'normal',
  p_source_task_id uuid default null, p_start_at timestamptz default null,
  p_due_at timestamptz default null, p_learner_ids uuid[] default array[]::uuid[]
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_task_id uuid; v_valid_learners uuid[]; v_invalid_learners uuid[];
begin
  if p_due_at is not null and p_start_at is not null and p_due_at < p_start_at then
    raise exception 'due_at cannot be before start_at' using errcode = 'P0010';
  end if;
  with deduped as (select distinct unnest(p_learner_ids) as sid),
  valid as (select s.id from public.students s inner join deduped d on s.id = d.sid where s.disabled_at is null)
  select array_agg(id) into v_valid_learners from valid;
  if v_valid_learners is null then v_valid_learners := array[]::uuid[]; end if;
  select array_agg(sid) into v_invalid_learners from unnest(p_learner_ids) as sid where sid not in (select unnest(v_valid_learners));
  if v_invalid_learners is not null and array_length(v_invalid_learners, 1) > 0 then
    raise exception 'Invalid or disabled learners: %', array_to_string(v_invalid_learners, ', ') using errcode = 'P0011';
  end if;
  insert into public.learning_tasks (course_id, title, description, created_by, status, task_type, source_task_id, start_at, due_at, completion_rule)
  values (p_course_id, p_title, p_description, p_created_by, 'draft', p_task_type, p_source_task_id, p_start_at, p_due_at,
    '{"version":1,"requiredScenes":"all","requiredChecks":"submitted_and_reviewed","explicitCompletion":true}'::jsonb)
  returning id into v_task_id;
  if array_length(v_valid_learners, 1) > 0 then
    insert into public.task_learners (task_id, student_id) select v_task_id, unnest(v_valid_learners);
  end if;
  return jsonb_build_object('task_id', v_task_id, 'learner_count', coalesce(array_length(v_valid_learners, 1), 0));
end; $$;
revoke execute on function public.create_task_with_learners from public, anon, authenticated;
grant execute on function public.create_task_with_learners to service_role;

-- ============================================================
-- RPC: replace_task_learners
-- ============================================================
create or replace function public.replace_task_learners(p_task_id uuid, p_learner_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_status text; v_validated_count integer; v_input_count integer;
begin
  select status into v_status from public.learning_tasks where id = p_task_id;
  if not found then raise exception 'Task not found' using errcode = 'P0012'; end if;
  if v_status <> 'draft' then raise exception 'Only draft tasks can modify learners' using errcode = 'P0013'; end if;

  -- 验证所有输入 ID 都存在且未禁用；有任何无效就整体拒绝
  select count(*) into v_input_count from unnest(p_learner_ids) as sid;
  select count(*) into v_validated_count
  from public.students s
  where s.id in (select unnest(p_learner_ids)) and s.disabled_at is null;

  if v_validated_count <> v_input_count then
    raise exception 'All learners must exist and not be disabled; got %/% valid', v_validated_count, v_input_count using errcode = 'P0011';
  end if;
  if v_validated_count = 0 then
    raise exception 'No valid learners provided' using errcode = 'P0011';
  end if;

  delete from public.task_learners where task_id = p_task_id;
  insert into public.task_learners (task_id, student_id) select p_task_id, unnest(p_learner_ids);

  return jsonb_build_object('task_id', p_task_id, 'learner_count', v_input_count);
end; $$;
revoke execute on function public.replace_task_learners from public, anon, authenticated;
grant execute on function public.replace_task_learners to service_role;

-- ============================================================
-- RPC: publish_task
-- ============================================================
create or replace function public.publish_task(p_task_id uuid, p_user_id uuid, p_source_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_task record; v_course record; v_snapshot_id uuid; v_token text; v_roster_count integer;
begin
  select id, course_id, status, snapshot_id, share_token into v_task from public.learning_tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found' using errcode = 'P0012'; end if;

  -- 幂等
  if v_task.status = 'published' then
    return jsonb_build_object('task_id', v_task.id, 'status', 'published', 'snapshot_id', v_task.snapshot_id, 'share_token', v_task.share_token, 'published', true);
  end if;
  if v_task.status <> 'draft' then
    raise exception 'Only draft tasks can be published' using errcode = 'P0013';
  end if;

  select count(*) into v_roster_count from public.task_learners where task_id = p_task_id;
  if v_roster_count = 0 then raise exception 'Task has no assigned learners' using errcode = 'P0014'; end if;

  select id, data into v_course from public.courses where id = v_task.course_id;
  if not found then raise exception 'Course not found' using errcode = 'P0015'; end if;

  -- hash 由调用方（TS canonicalJson）计算，SQL 只验证非空
  if p_source_hash is null or p_source_hash = '' then
    raise exception 'source_hash is required' using errcode = 'P0010';
  end if;

  insert into public.course_snapshots (course_id, source_hash, snapshot_data, created_by)
  values (v_task.course_id, p_source_hash,
    jsonb_build_object('stage', v_course.data->'stage', 'scenes', v_course.data->'scenes', 'outlines', v_course.data->'outlines', 'sourceHash', p_source_hash, 'generatedAt', now()),
    p_user_id)
  on conflict (course_id, source_hash) do nothing;

  select id into v_snapshot_id from public.course_snapshots where course_id = v_task.course_id and source_hash = p_source_hash;
  if not found then raise exception 'Snapshot creation failed'; end if;

  v_token := rtrim(replace(replace(encode(extensions.gen_random_bytes(32), 'base64'), '+', '-'), '/', '_'), '=');

  update public.learning_tasks set status = 'published', snapshot_id = v_snapshot_id, share_token = v_token, published_at = now()
  where id = p_task_id and status = 'draft';

  if not found then
    -- 并发失败：读回已落地结果
    select id, status, snapshot_id, share_token into v_task from public.learning_tasks where id = p_task_id;
    return jsonb_build_object('task_id', v_task.id, 'status', v_task.status, 'snapshot_id', v_task.snapshot_id, 'share_token', v_task.share_token, 'published', v_task.status = 'published');
  end if;

  return jsonb_build_object('task_id', p_task_id, 'status', 'published', 'snapshot_id', v_snapshot_id, 'share_token', v_token, 'published', true);
end; $$;
revoke execute on function public.publish_task from public, anon, authenticated;
grant execute on function public.publish_task to service_role;

-- ============================================================
-- RPC: count_task_learners
-- ============================================================
create or replace function public.count_task_learners(p_task_ids uuid[])
returns table(task_id uuid, count integer) language sql stable security definer set search_path = '' as $$
  select tl.task_id, count(*)::integer
  from public.task_learners tl
  where tl.task_id = any(p_task_ids)
  group by tl.task_id;
$$;
revoke execute on function public.count_task_learners from public, anon, authenticated;
grant execute on function public.count_task_learners to service_role;
