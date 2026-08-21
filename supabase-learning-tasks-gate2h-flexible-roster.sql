-- Gate 2H: published tasks may freely adjust their learner roster.
-- Course package and task configuration remain frozen after publication.

create or replace function public.check_task_learners_frozen()
returns trigger as $$
declare t_status text;
begin
  select status into t_status
  from public.learning_tasks
  where id = case when tg_op = 'INSERT' then new.task_id else old.task_id end;

  if t_status is null then return null; end if;
  if t_status not in ('draft', 'published') then
    raise exception 'Cannot change learners on a closed or archived task';
  end if;
  if tg_op = 'INSERT' then return new; else return old; end if;
end;
$$ language plpgsql;

create or replace function public.replace_task_learners(p_task_id uuid, p_learner_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_status text; v_validated_count integer; v_input_count integer;
begin
  select status into v_status from public.learning_tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found' using errcode = 'P0012'; end if;
  if v_status not in ('draft', 'published') then
    raise exception 'Only draft or published tasks can modify learners' using errcode = 'P0013';
  end if;

  select count(distinct sid) into v_input_count from unnest(coalesce(p_learner_ids, '{}'::uuid[])) as sid;
  if v_input_count > 0 then
    select count(*) into v_validated_count
    from public.students s
    where s.id in (select unnest(p_learner_ids)) and s.disabled_at is null;
    if v_validated_count <> v_input_count then
      raise exception 'All learners must exist and not be disabled' using errcode = 'P0011';
    end if;
  end if;

  -- 保留仍在名单中的学习记录；移出者不再属于此任务，其进度事实也一并清理。
  delete from public.task_learning_events
  where task_id = p_task_id and student_id <> all(coalesce(p_learner_ids, '{}'::uuid[]));
  delete from public.task_course_progress
  where task_id = p_task_id and student_id <> all(coalesce(p_learner_ids, '{}'::uuid[]));
  delete from public.task_learners
  where task_id = p_task_id and student_id <> all(coalesce(p_learner_ids, '{}'::uuid[]));

  insert into public.task_learners (task_id, student_id)
  select p_task_id, sid from (select distinct unnest(coalesce(p_learner_ids, '{}'::uuid[])) as sid) input
  on conflict (task_id, student_id) do nothing;

  return jsonb_build_object('task_id', p_task_id, 'learner_count', v_input_count);
end;
$$;

revoke execute on function public.replace_task_learners(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.replace_task_learners(uuid, uuid[]) to service_role;
