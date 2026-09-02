-- Gate 1F: published tasks may add learners, but never remove existing learners.

create or replace function public.check_task_learners_frozen()
returns trigger as $$
declare t_status text;
begin
  select status into t_status
  from public.learning_tasks
  where id = case when tg_op = 'INSERT' then new.task_id else old.task_id end;

  if t_status is null then return null; end if;
  if tg_op = 'DELETE' and t_status <> 'draft' then
    raise exception 'Cannot remove learners after a task is published';
  end if;
  if tg_op = 'INSERT' and t_status not in ('draft', 'published') then
    raise exception 'Cannot add learners to a closed or archived task';
  end if;
  if tg_op = 'INSERT' then return new; else return old; end if;
end;
$$ language plpgsql;

create or replace function public.add_task_learners(p_task_id uuid, p_learner_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_status text; v_validated_count integer; v_input_count integer;
begin
  select status into v_status from public.learning_tasks where id = p_task_id;
  if not found then raise exception 'Task not found' using errcode = 'P0012'; end if;
  if v_status not in ('draft', 'published') then
    raise exception 'Only draft or published tasks can add learners' using errcode = 'P0013';
  end if;

  select count(distinct sid) into v_input_count from unnest(p_learner_ids) as sid;
  select count(*) into v_validated_count
  from public.students s
  where s.id in (select unnest(p_learner_ids)) and s.disabled_at is null;
  if v_validated_count <> v_input_count or v_validated_count = 0 then
    raise exception 'All learners must exist and not be disabled' using errcode = 'P0011';
  end if;

  insert into public.task_learners (task_id, student_id)
  select p_task_id, sid from (select distinct unnest(p_learner_ids) as sid) input
  on conflict (task_id, student_id) do nothing;

  return jsonb_build_object('task_id', p_task_id);
end;
$$;

revoke execute on function public.add_task_learners from public, anon, authenticated;
grant execute on function public.add_task_learners to service_role;
