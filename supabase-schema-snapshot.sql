


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."add_task_learners"("p_task_id" "uuid", "p_learner_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."add_task_learners"("p_task_id" "uuid", "p_learner_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_learning_tasks_immutability"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
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
$$;


ALTER FUNCTION "public"."check_learning_tasks_immutability"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_task_courses_frozen"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
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
$$;


ALTER FUNCTION "public"."check_task_courses_frozen"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_task_learners_frozen"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
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
$$;


ALTER FUNCTION "public"."check_task_learners_frozen"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."course_revoice_jobs" (
    "id" "text" NOT NULL,
    "course_id" "text" NOT NULL,
    "requested_by" "text" NOT NULL,
    "status" "text" NOT NULL,
    "voice" "jsonb" NOT NULL,
    "snapshot" "jsonb" NOT NULL,
    "source_updated_at" timestamp with time zone NOT NULL,
    "items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "total_items" integer DEFAULT 0 NOT NULL,
    "completed_items" integer DEFAULT 0 NOT NULL,
    "failed_items" integer DEFAULT 0 NOT NULL,
    "message" "text" DEFAULT ''::"text" NOT NULL,
    "error" "text",
    "locked_until" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "course_revoice_jobs_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'running'::"text", 'succeeded'::"text", 'failed'::"text", 'cancelled'::"text", 'conflict'::"text"])))
);


ALTER TABLE "public"."course_revoice_jobs" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_course_revoice_job"("p_job_id" "text") RETURNS SETOF "public"."course_revoice_jobs"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  return query
  update public.course_revoice_jobs
  set status = 'running',
      started_at = coalesce(started_at, now()),
      locked_until = now() + interval '5 minutes',
      updated_at = now(),
      message = '正在生成配音'
  where id = p_job_id
    and status in ('queued', 'running')
    and (locked_until is null or locked_until < now())
  returning *;
end;
$$;


ALTER FUNCTION "public"."claim_course_revoice_job"("p_job_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."commit_course_revoice_job"("p_job_id" "text", "p_course_id" "text", "p_source_updated_at" timestamp with time zone, "p_course_data" "jsonb") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_course_updated integer := 0;
begin
  if not exists (
    select 1 from public.course_revoice_jobs
    where id = p_job_id and course_id = p_course_id and status = 'running'
    for update
  ) then
    return 'cancelled';
  end if;

  update public.courses
  set data = p_course_data,
      updated_at = now()
  where id = p_course_id
    and updated_at = p_source_updated_at;
  get diagnostics v_course_updated = row_count;

  update public.course_revoice_jobs
  set status = case when v_course_updated = 1 then 'succeeded' else 'conflict' end,
      message = case
        when v_course_updated = 1 then '重新配音已完成并保存到云端'
        else '课程在生成期间已被编辑，未覆盖新内容'
      end,
      completed_at = now(),
      locked_until = null,
      updated_at = now()
  where id = p_job_id and status = 'running';

  return case when v_course_updated = 1 then 'succeeded' else 'conflict' end;
end;
$$;


ALTER FUNCTION "public"."commit_course_revoice_job"("p_job_id" "text", "p_course_id" "text", "p_source_updated_at" timestamp with time zone, "p_course_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."count_task_learners"("p_task_ids" "uuid"[]) RETURNS TABLE("task_id" "uuid", "count" integer)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select tl.task_id, count(*)::integer
  from public.task_learners tl
  where tl.task_id = any(p_task_ids)
  group by tl.task_id;
$$;


ALTER FUNCTION "public"."count_task_learners"("p_task_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_task_course_progress_for_learner"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  insert into public.task_course_progress(task_id, student_id, course_id)
  select new.task_id, new.student_id, course_id
  from public.task_courses where task_id = new.task_id
  on conflict do nothing;
  return new;
end;
$$;


ALTER FUNCTION "public"."create_task_course_progress_for_learner"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_task_with_learners"("p_course_id" "text", "p_title" "text", "p_description" "text" DEFAULT NULL::"text", "p_created_by" "uuid" DEFAULT "auth"."uid"(), "p_task_type" "text" DEFAULT 'normal'::"text", "p_source_task_id" "uuid" DEFAULT NULL::"uuid", "p_start_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_due_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_learner_ids" "uuid"[] DEFAULT ARRAY[]::"uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."create_task_with_learners"("p_course_id" "text", "p_title" "text", "p_description" "text", "p_created_by" "uuid", "p_task_type" "text", "p_source_task_id" "uuid", "p_start_at" timestamp with time zone, "p_due_at" timestamp with time zone, "p_learner_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_display_name text;
begin
  v_display_name := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'name'), ''),
    split_part(coalesce(new.email, ''), '@', 1)
  );

  insert into public.profiles (id, role, display_name)
  values (new.id, 'learner', v_display_name)
  on conflict (id) do update
    set display_name = coalesce(public.profiles.display_name, excluded.display_name);

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_snapshot_modification"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'course_snapshots are immutable and cannot be updated';
  elsif tg_op = 'DELETE' then
    raise exception 'course_snapshots are immutable and cannot be deleted';
  end if;
end;
$$;


ALTER FUNCTION "public"."prevent_snapshot_modification"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."publish_task"("p_task_id" "uuid", "p_user_id" "uuid", "p_source_hash" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."publish_task"("p_task_id" "uuid", "p_user_id" "uuid", "p_source_hash" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."publish_task_course_package"("p_task_id" "uuid", "p_user_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  update public.learning_tasks set status = 'published', snapshot_id = v_primary_snapshot, share_token = v_token, published_at = now() where id = p_task_id;
  insert into public.task_course_progress(task_id, student_id, course_id)
  select tl.task_id, tl.student_id, tc.course_id from public.task_learners tl join public.task_courses tc on tc.task_id = tl.task_id where tl.task_id = p_task_id
  on conflict do nothing;
  return jsonb_build_object('task_id', p_task_id, 'status', 'published', 'share_token', v_token, 'published', true);
end;
$$;


ALTER FUNCTION "public"."publish_task_course_package"("p_task_id" "uuid", "p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_task_courses"("p_task_id" "uuid", "p_course_ids" "text"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."replace_task_courses"("p_task_id" "uuid", "p_course_ids" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_task_learners"("p_task_id" "uuid", "p_learner_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."replace_task_learners"("p_task_id" "uuid", "p_learner_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."runtime_append_record"("p_session_id" "text", "p_id" "text", "p_scene_id" "text", "p_action_index" integer, "p_sub_anchor" "text", "p_created_at" "text", "p_payload" "text", "p_expect_revision" bigint) RETURNS "text"
    LANGUAGE "sql"
    AS $$
with cur as (
  select s.id, s.revision, s.status from runtime_sessions s where s.id = p_session_id
),
upd as (
  -- UPDATE 行锁使同会话并发 append 串行化；READ COMMITTED 下等待方在锁释放后
  -- 基于已提交的新行重新求值（status / revision 都是新值），两个并发 append
  -- 拿到不同 seq。revision CAS 挡住预读到写入之间的并发改动。
  -- 幂等重放（record id 已存在）时整个 upd 为空：不消耗 seq、不增加 revision。
  update runtime_sessions set next_seq = next_seq + 1, revision = revision + 1
  where id = p_session_id
    and revision = p_expect_revision
    and status = 'active'
    and not exists (select 1 from runtime_records r where r.id = p_id)
  returning next_seq as seq
),
ins as (
  insert into runtime_records (session_id, seq, id, scene_id, action_index, sub_anchor, created_at, payload)
  select p_session_id, upd.seq - 1, p_id,
         case when p_scene_id = '' then null else p_scene_id end,
         case when p_action_index = -1 then null else p_action_index end,
         case when p_sub_anchor = '' then null else p_sub_anchor end,
         p_created_at::timestamptz, p_payload::jsonb
  from upd
  returning id
)
select case
    when not exists (select 1 from cur) then 'no_session'
    when exists (select 1 from ins) then 'ok'
    -- 幂等重放优先于状态/CAS 判定：已落库的 record 重放应幂等成功，
    -- 即使会话此后已 completed 或已被其他写入推进 revision（outbox 延迟 flush）
    when exists (select 1 from runtime_records r where r.id = p_id) then 'id_conflict'
    when (select c.status from cur c) <> 'active' then 'inactive_session'
    else 'conflict' end
$$;


ALTER FUNCTION "public"."runtime_append_record"("p_session_id" "text", "p_id" "text", "p_scene_id" "text", "p_action_index" integer, "p_sub_anchor" "text", "p_created_at" "text", "p_payload" "text", "p_expect_revision" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."runtime_create_session"("p_id" "text", "p_version" "text", "p_kind" "text", "p_stage_id" "text", "p_learner_key" "text", "p_status" "text", "p_created_at" "text", "p_updated_at" "text") RETURNS "text"
    LANGUAGE "sql"
    AS $$
with lock as (
  -- learner 级咨询锁（ins 以 from lock 引用，强制求值）
  select pg_advisory_xact_lock(hashtext(p_learner_key)) as k
),
pre as (
  -- 前置存在性判定必须是命名 CTE（在 ins 之前求值）：最终 SELECT 里直接
  -- 子查询基表在某些执行器下会看到插入后快照，把新鲜插入误判为 conflict
  select 1 as x from runtime_sessions s where s.id = p_id
),
ins as (
  -- not-exists 前置守卫挡住串行重复（不触发 ON CONFLICT 路径）；ON CONFLICT
  -- 只兜并发竞争（等待方锁释放后 not-exists 重评仍为假则不插入）。
  -- 真 PG 下冲突时 returning 为空 → 'conflict'；并发双方恰好一个 'ok'。
  insert into runtime_sessions (id, runtime_dsl_version, kind, stage_id, learner_key, status, created_at, updated_at)
  select p_id, p_version, p_kind, p_stage_id, p_learner_key, p_status,
         p_created_at::timestamptz, p_updated_at::timestamptz
  from lock
  where not exists (select 1 from pre)
  on conflict (id) do nothing
  returning id
)
select case when exists (select 1 from ins) then 'ok' else 'conflict' end
$$;


ALTER FUNCTION "public"."runtime_create_session"("p_id" "text", "p_version" "text", "p_kind" "text", "p_stage_id" "text", "p_learner_key" "text", "p_status" "text", "p_created_at" "text", "p_updated_at" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."runtime_delete_learner_runtime"("p_stage_id" "text", "p_learner_key" "text") RETURNS integer
    LANGUAGE "sql"
    AS $$
  with del as (delete from runtime_sessions where stage_id = p_stage_id and learner_key = p_learner_key returning id)
  select cast((select count(*) from del) as integer)
$$;


ALTER FUNCTION "public"."runtime_delete_learner_runtime"("p_stage_id" "text", "p_learner_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."runtime_delete_session"("p_id" "text") RETURNS integer
    LANGUAGE "sql"
    AS $$
  with del as (delete from runtime_sessions where id = p_id returning id)
  select cast((select count(*) from del) as integer)
$$;


ALTER FUNCTION "public"."runtime_delete_session"("p_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."runtime_delete_stage_runtime"("p_stage_id" "text") RETURNS integer
    LANGUAGE "sql"
    AS $$
  with del as (delete from runtime_sessions where stage_id = p_stage_id returning id)
  select cast((select count(*) from del) as integer)
$$;


ALTER FUNCTION "public"."runtime_delete_stage_runtime"("p_stage_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."runtime_get_record"("p_id" "text") RETURNS TABLE("session_id" "text", "seq" integer, "id" "text", "scene_id" "text", "action_index" integer, "sub_anchor" "text", "created_at" timestamp with time zone, "payload" "jsonb")
    LANGUAGE "sql"
    AS $$
  select r.session_id, r.seq, r.id, r.scene_id, r.action_index, r.sub_anchor,
         r.created_at, r.payload
  from runtime_records r where r.id = p_id
$$;


ALTER FUNCTION "public"."runtime_get_record"("p_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."runtime_get_session"("p_id" "text") RETURNS TABLE("id" "text", "runtime_dsl_version" "text", "revision" bigint, "kind" "text", "stage_id" "text", "learner_key" "text", "status" "text", "created_at" timestamp with time zone, "updated_at" timestamp with time zone, "next_seq" integer)
    LANGUAGE "sql"
    AS $$
  select s.id, s.runtime_dsl_version, s.revision, s.kind, s.stage_id, s.learner_key,
         s.status, s.created_at, s.updated_at, s.next_seq
  from runtime_sessions s where s.id = p_id
$$;


ALTER FUNCTION "public"."runtime_get_session"("p_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."runtime_list_records"("p_session_id" "text") RETURNS TABLE("session_id" "text", "seq" integer, "id" "text", "scene_id" "text", "action_index" integer, "sub_anchor" "text", "created_at" timestamp with time zone, "payload" "jsonb")
    LANGUAGE "sql"
    AS $$
  select r.session_id, r.seq, r.id, r.scene_id, r.action_index, r.sub_anchor,
         r.created_at, r.payload
  from runtime_records r
  where r.session_id = p_session_id
  order by r.seq asc
$$;


ALTER FUNCTION "public"."runtime_list_records"("p_session_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."runtime_list_records_by_scene"("p_session_id" "text", "p_scene_id" "text") RETURNS TABLE("session_id" "text", "seq" integer, "id" "text", "scene_id" "text", "action_index" integer, "sub_anchor" "text", "created_at" timestamp with time zone, "payload" "jsonb")
    LANGUAGE "sql"
    AS $$
  select r.session_id, r.seq, r.id, r.scene_id, r.action_index, r.sub_anchor,
         r.created_at, r.payload
  from runtime_records r
  where r.session_id = p_session_id and r.scene_id = p_scene_id
  order by r.seq asc
$$;


ALTER FUNCTION "public"."runtime_list_records_by_scene"("p_session_id" "text", "p_scene_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."runtime_list_sessions"("p_stage_id" "text", "p_learner_key" "text") RETURNS TABLE("id" "text", "runtime_dsl_version" "text", "revision" bigint, "kind" "text", "stage_id" "text", "learner_key" "text", "status" "text", "created_at" timestamp with time zone, "updated_at" timestamp with time zone, "next_seq" integer)
    LANGUAGE "sql"
    AS $$
  select s.id, s.runtime_dsl_version, s.revision, s.kind, s.stage_id, s.learner_key,
         s.status, s.created_at, s.updated_at, s.next_seq
  from runtime_sessions s
  where s.stage_id = p_stage_id and s.learner_key = p_learner_key
  order by s.created_at asc, s.id asc
$$;


ALTER FUNCTION "public"."runtime_list_sessions"("p_stage_id" "text", "p_learner_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."runtime_list_sessions_by_learner"("p_learner_key" "text") RETURNS TABLE("id" "text", "runtime_dsl_version" "text", "revision" bigint, "kind" "text", "stage_id" "text", "learner_key" "text", "status" "text", "created_at" timestamp with time zone, "updated_at" timestamp with time zone, "next_seq" integer)
    LANGUAGE "sql"
    AS $$
  select s.id, s.runtime_dsl_version, s.revision, s.kind, s.stage_id, s.learner_key,
         s.status, s.created_at, s.updated_at, s.next_seq
  from runtime_sessions s
  where s.learner_key = p_learner_key
  order by s.created_at asc, s.id asc
$$;


ALTER FUNCTION "public"."runtime_list_sessions_by_learner"("p_learner_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."runtime_merge_learner"("p_from" "text", "p_to" "text", "p_expect_version" "text") RETURNS "text"
    LANGUAGE "sql"
    AS $$
with lock as (
  select pg_advisory_xact_lock(hashtext(p_from)) as k
),
bad_version as (
  select 1 from runtime_sessions s
  where s.learner_key = p_from and s.runtime_dsl_version <> p_expect_version
    and exists (select 1 from lock)
  limit 1
),
upd as (
  update runtime_sessions set learner_key = p_to, revision = revision + 1
  where learner_key = p_from
    and exists (select 1 from lock)
    and not exists (select 1 from bad_version)
  returning id
),
moved as (select cast(count(*) as text) as n from upd)
select case
  when exists (select 1 from bad_version) then 'version_conflict'
  else concat('ok:', m.n) end
from moved m
$$;


ALTER FUNCTION "public"."runtime_merge_learner"("p_from" "text", "p_to" "text", "p_expect_version" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."runtime_merge_with_grant"("p_grant_id" "text", "p_from" "text", "p_to" "text", "p_expect_version" "text", "p_now" "text") RETURNS "text"
    LANGUAGE "sql"
    AS $$
with grant_ok as (
  select g.id from runtime_merge_grants g
  where g.id = p_grant_id and g.from_learner_key = p_from and g.to_learner_key = p_to
    and g.used_at is null and g.expires_at > p_now::timestamptz
),
lock as (
  -- grant 无效时取锁无害（短暂串行）；upd/claim 的 grant 门控在各自 WHERE 里
  select pg_advisory_xact_lock(hashtext(p_from)) as k
),
bad_version as (
  select 1 from runtime_sessions s
  where s.learner_key = p_from and s.runtime_dsl_version <> p_expect_version
    and exists (select 1 from grant_ok)
    and exists (select 1 from lock)
  limit 1
),
claim as (
  -- 核销先行（data-modifying CTE，PG 保证恰好执行一次）；version_conflict
  -- 时不核销，grant 保留供迁移后重试。
  -- 关键可变条件（from/to/未用/未过期）在 UPDATE WHERE 里直接重写一遍——
  -- 这不是冗余：两个请求共用同一 grant 时，等待咨询锁的一方持语句快照，
  -- CTE 里的 grant_ok 仍看见「未使用」；只有 UPDATE 自身的直接条件会在
  -- READ COMMITTED 的 EvalPlanQual 里对最新行版本重检，挡住双重核销
  -- （Codex R1.1 联合评审第 1 条）。IN-CTE 子查询有执行器兼容风险
  -- （探针 18），故用 exists(grant_ok) + 直接列条件。
  update runtime_merge_grants set used_at = p_now::timestamptz
  where id = p_grant_id
    and from_learner_key = p_from
    and to_learner_key = p_to
    and used_at is null
    and expires_at > p_now::timestamptz
    and exists (select 1 from grant_ok)
    and exists (select 1 from lock)
    and not exists (select 1 from bad_version)
  returning id
),
upd as (
  -- 搬移门控只读 claim 的 RETURNING（CTE 输出，快照安全）——绝不能回读
  -- runtime_merge_grants：claim 已改该表，快照不一致的执行器按求值顺序
  -- 会把门控重估为空，导致「核销了却没搬移」（探针 19 实证）。
  -- 依赖方向强制 claim 先于 upd 求值；claim 为空（grant 无效/版本冲突）
  -- 时 upd 必然为空——核销与搬移同生同灭。
  update runtime_sessions set learner_key = p_to, revision = revision + 1
  where learner_key = p_from
    and exists (select 1 from claim)
  returning id
),
moved as (select cast(count(*) as text) as n from upd),
claimed as (
  -- claim 必须被引用——未引用的 CTE 可能被跳过执行（真 PG 对 data-modifying
  -- CTE 有保证，但跨执行器不假设这一点）
  select count(*) as c from claim
)
select case
  when exists (select 1 from bad_version) then 'version_conflict'
  when cl.c > 0 then concat('ok:', m.n)
  else 'invalid_grant' end
from moved m, claimed cl
$$;


ALTER FUNCTION "public"."runtime_merge_with_grant"("p_grant_id" "text", "p_from" "text", "p_to" "text", "p_expect_version" "text", "p_now" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."runtime_update_session"("p_id" "text", "p_version" "text", "p_kind" "text", "p_stage_id" "text", "p_learner_key" "text", "p_status" "text", "p_created_at" "text", "p_updated_at" "text", "p_expect_revision" bigint) RETURNS "text"
    LANGUAGE "sql"
    AS $$
with cur as (select s.id, s.revision from runtime_sessions s where s.id = p_id),
upd as (
  update runtime_sessions set
    runtime_dsl_version = p_version, kind = p_kind, stage_id = p_stage_id,
    learner_key = p_learner_key, status = p_status,
    created_at = p_created_at::timestamptz, updated_at = p_updated_at::timestamptz,
    revision = revision + 1
  where id = p_id and revision = p_expect_revision
  returning id
)
select case
  when not exists (select 1 from cur) then 'no_session'
  when exists (select 1 from upd) then 'ok'
  else 'conflict' end
$$;


ALTER FUNCTION "public"."runtime_update_session"("p_id" "text", "p_version" "text", "p_kind" "text", "p_stage_id" "text", "p_learner_key" "text", "p_status" "text", "p_created_at" "text", "p_updated_at" "text", "p_expect_revision" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_staff_learning_identity"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text;
begin
  if new.role not in ('teacher', 'admin') then
    return new;
  end if;

  select email into v_email from auth.users where id = new.id;
  if v_email is null then return new; end if;

  insert into public.students (name, email, user_id, disabled_at)
  values (
    coalesce(nullif(trim(new.display_name), ''), split_part(v_email, '@', 1)),
    v_email,
    new.id,
    new.disabled_at
  )
  on conflict (user_id) where user_id is not null do update
    set name = excluded.name,
        disabled_at = excluded.disabled_at,
        updated_at = now();

  return new;
end;
$$;


ALTER FUNCTION "public"."sync_staff_learning_identity"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_ai_intervention_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ begin new.updated_at = now(); return new; end; $$;


ALTER FUNCTION "public"."touch_ai_intervention_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_task_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ begin new.updated_at = now(); return new; end; $$;


ALTER FUNCTION "public"."touch_task_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upgrade_seed_admin"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_target text;
begin
  v_target := nullif(lower(current_setting('app.seed_admin_email', true)), '');
  if v_target is not null and lower(coalesce(new.email, '')) = v_target then
    update public.profiles
      set role = 'admin'
      where id = new.id;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."upgrade_seed_admin"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_intervention_suggestions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "task_id" "uuid" NOT NULL,
    "learner_ids" "uuid"[] NOT NULL,
    "scene_ids" "text"[] DEFAULT ARRAY[]::"text"[] NOT NULL,
    "reason" "text" NOT NULL,
    "evidence" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_task_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_intervention_suggestions_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'ignored'::"text"])))
);


ALTER TABLE "public"."ai_intervention_suggestions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_learning_summaries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "task_id" "uuid" NOT NULL,
    "scope" "text" NOT NULL,
    "student_id" "uuid",
    "content" "jsonb" NOT NULL,
    "model" "text" NOT NULL,
    "prompt_version" "text" DEFAULT 'gate1e-v1'::"text" NOT NULL,
    "data_version" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_learning_summaries_check" CHECK (((("scope" = 'class'::"text") AND ("student_id" IS NULL)) OR (("scope" = 'learner'::"text") AND ("student_id" IS NOT NULL)))),
    CONSTRAINT "ai_learning_summaries_scope_check" CHECK (("scope" = ANY (ARRAY['class'::"text", 'learner'::"text"])))
);


ALTER TABLE "public"."ai_learning_summaries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."course_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "course_id" "text" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'not_started'::"text" NOT NULL,
    "assigned_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "last_seen_at" timestamp with time zone,
    "due_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "course_assignments_status_check" CHECK (("status" = ANY (ARRAY['not_started'::"text", 'in_progress'::"text", 'completed'::"text"])))
);


ALTER TABLE "public"."course_assignments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."course_progress_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "course_id" "text" NOT NULL,
    "student_id" "uuid",
    "assignment_id" "uuid",
    "event_type" "text" NOT NULL,
    "scene_id" "text",
    "scene_order" integer,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "course_progress_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['open_course'::"text", 'view_scene'::"text", 'complete_course'::"text"])))
);


ALTER TABLE "public"."course_progress_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."course_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "course_id" "text" NOT NULL,
    "source_hash" "text" NOT NULL,
    "snapshot_data" "jsonb" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."course_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."courses" (
    "id" "text" NOT NULL,
    "title" "text" DEFAULT ''::"text" NOT NULL,
    "topic" "text" DEFAULT ''::"text",
    "data" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "text" DEFAULT ''::"text"
);


ALTER TABLE "public"."courses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."learning_tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "course_id" "text" NOT NULL,
    "snapshot_id" "uuid",
    "title" "text" NOT NULL,
    "description" "text",
    "created_by" "uuid" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "task_type" "text" DEFAULT 'normal'::"text" NOT NULL,
    "source_task_id" "uuid",
    "start_at" timestamp with time zone,
    "due_at" timestamp with time zone,
    "completion_rule" "jsonb" DEFAULT '{"version": 1, "requiredChecks": "submitted_and_reviewed", "requiredScenes": "all", "explicitCompletion": true}'::"jsonb" NOT NULL,
    "share_token" "text",
    "published_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "learning_tasks_draft_no_published_at" CHECK ((("status" <> 'draft'::"text") OR ("published_at" IS NULL))),
    CONSTRAINT "learning_tasks_published_check" CHECK ((("status" <> 'published'::"text") OR (("snapshot_id" IS NOT NULL) AND ("share_token" IS NOT NULL) AND ("published_at" IS NOT NULL)))),
    CONSTRAINT "learning_tasks_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text", 'closed'::"text", 'archived'::"text"]))),
    CONSTRAINT "learning_tasks_task_type_check" CHECK (("task_type" = ANY (ARRAY['normal'::"text", 'remedial'::"text"]))),
    CONSTRAINT "learning_tasks_time_range" CHECK ((("due_at" IS NULL) OR ("start_at" IS NULL) OR ("due_at" >= "start_at"))),
    CONSTRAINT "learning_tasks_token_length" CHECK ((("share_token" IS NULL) OR ("length"("share_token") >= 16))),
    CONSTRAINT "learning_tasks_type_source_check" CHECK (((("task_type" = 'normal'::"text") AND ("source_task_id" IS NULL)) OR (("task_type" = 'remedial'::"text") AND ("source_task_id" IS NOT NULL))))
);


ALTER TABLE "public"."learning_tasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'learner'::"text" NOT NULL,
    "display_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "disabled_at" timestamp with time zone,
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'teacher'::"text", 'learner'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."runtime_merge_grants" (
    "id" "text" NOT NULL,
    "from_learner_key" "text" NOT NULL,
    "to_learner_key" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."runtime_merge_grants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."runtime_records" (
    "session_id" "text" NOT NULL,
    "seq" integer NOT NULL,
    "id" "text" NOT NULL,
    "scene_id" "text",
    "action_index" integer,
    "sub_anchor" "text",
    "created_at" timestamp with time zone NOT NULL,
    "payload" "jsonb" NOT NULL
);


ALTER TABLE "public"."runtime_records" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."runtime_sessions" (
    "id" "text" NOT NULL,
    "runtime_dsl_version" "text" NOT NULL,
    "revision" bigint DEFAULT 0 NOT NULL,
    "kind" "text" NOT NULL,
    "stage_id" "text" NOT NULL,
    "learner_key" "text" NOT NULL,
    "status" "text" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone NOT NULL,
    "next_seq" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "runtime_sessions_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'completed'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."runtime_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."students" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "email" "text",
    "employee_no" "text",
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "access_code" "text" DEFAULT "upper"(SUBSTRING("md5"(("random"())::"text") FROM 1 FOR 6)),
    "user_id" "uuid",
    "disabled_at" timestamp with time zone
);


ALTER TABLE "public"."students" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_course_progress" (
    "task_id" "uuid" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "course_id" "text" NOT NULL,
    "status" "text" DEFAULT 'not_started'::"text" NOT NULL,
    "progress_percent" numeric DEFAULT 0 NOT NULL,
    "effective_seconds" integer DEFAULT 0 NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "last_seen_at" timestamp with time zone,
    "completed_scene_count" integer DEFAULT 0 NOT NULL,
    "total_scene_count" integer DEFAULT 0 NOT NULL,
    "last_scene_id" "text",
    "mastery_percent" numeric,
    CONSTRAINT "task_course_progress_effective_seconds_check" CHECK (("effective_seconds" >= 0)),
    CONSTRAINT "task_course_progress_progress_percent_check" CHECK ((("progress_percent" >= (0)::numeric) AND ("progress_percent" <= (100)::numeric))),
    CONSTRAINT "task_course_progress_status_check" CHECK (("status" = ANY (ARRAY['not_started'::"text", 'in_progress'::"text", 'completed'::"text"])))
);


ALTER TABLE "public"."task_course_progress" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_courses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "task_id" "uuid" NOT NULL,
    "course_id" "text" NOT NULL,
    "position" integer DEFAULT 1 NOT NULL,
    "is_required" boolean DEFAULT true NOT NULL,
    "snapshot_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "task_courses_position_check" CHECK (("position" > 0))
);


ALTER TABLE "public"."task_courses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_learners" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "task_id" "uuid" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'not_started'::"text" NOT NULL,
    "progress_percent" numeric DEFAULT 0 NOT NULL,
    "completed_scene_count" integer DEFAULT 0 NOT NULL,
    "total_scene_count" integer DEFAULT 0 NOT NULL,
    "effective_seconds" integer DEFAULT 0 NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "last_seen_at" timestamp with time zone,
    "last_scene_id" "text",
    "assigned_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "mastery_percent" numeric,
    "completion_requested_at" timestamp with time zone,
    CONSTRAINT "task_learners_check" CHECK (("completed_scene_count" <= "total_scene_count")),
    CONSTRAINT "task_learners_completed_scene_count_check" CHECK (("completed_scene_count" >= 0)),
    CONSTRAINT "task_learners_effective_seconds_check" CHECK (("effective_seconds" >= 0)),
    CONSTRAINT "task_learners_progress_percent_check" CHECK ((("progress_percent" >= (0)::numeric) AND ("progress_percent" <= (100)::numeric))),
    CONSTRAINT "task_learners_status_check" CHECK (("status" = ANY (ARRAY['not_started'::"text", 'in_progress'::"text", 'completed'::"text"]))),
    CONSTRAINT "task_learners_total_scene_count_check" CHECK (("total_scene_count" >= 0))
);


ALTER TABLE "public"."task_learners" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_learning_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "task_id" "uuid" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "client_event_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "scene_id" "text",
    "scene_order" integer,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "course_id" "text",
    CONSTRAINT "task_learning_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['task_opened'::"text", 'scene_started'::"text", 'scene_completed'::"text", 'heartbeat'::"text", 'question_asked'::"text", 'check_submitted'::"text", 'check_reviewed'::"text", 'task_completed'::"text"])))
);


ALTER TABLE "public"."task_learning_events" OWNER TO "postgres";


ALTER TABLE ONLY "public"."ai_intervention_suggestions"
    ADD CONSTRAINT "ai_intervention_suggestions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_learning_summaries"
    ADD CONSTRAINT "ai_learning_summaries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."course_assignments"
    ADD CONSTRAINT "course_assignments_course_id_student_id_key" UNIQUE ("course_id", "student_id");



ALTER TABLE ONLY "public"."course_assignments"
    ADD CONSTRAINT "course_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."course_progress_events"
    ADD CONSTRAINT "course_progress_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."course_revoice_jobs"
    ADD CONSTRAINT "course_revoice_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."course_snapshots"
    ADD CONSTRAINT "course_snapshots_course_hash_unique" UNIQUE ("course_id", "source_hash");



ALTER TABLE ONLY "public"."course_snapshots"
    ADD CONSTRAINT "course_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."courses"
    ADD CONSTRAINT "courses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."learning_tasks"
    ADD CONSTRAINT "learning_tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."learning_tasks"
    ADD CONSTRAINT "learning_tasks_share_token_key" UNIQUE ("share_token");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."runtime_merge_grants"
    ADD CONSTRAINT "runtime_merge_grants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."runtime_records"
    ADD CONSTRAINT "runtime_records_pkey" PRIMARY KEY ("session_id", "seq");



ALTER TABLE ONLY "public"."runtime_sessions"
    ADD CONSTRAINT "runtime_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."students"
    ADD CONSTRAINT "students_access_code_key" UNIQUE ("access_code");



ALTER TABLE ONLY "public"."students"
    ADD CONSTRAINT "students_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_course_progress"
    ADD CONSTRAINT "task_course_progress_pkey" PRIMARY KEY ("task_id", "student_id", "course_id");



ALTER TABLE ONLY "public"."task_courses"
    ADD CONSTRAINT "task_courses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_courses"
    ADD CONSTRAINT "task_courses_task_id_course_id_key" UNIQUE ("task_id", "course_id");



ALTER TABLE ONLY "public"."task_courses"
    ADD CONSTRAINT "task_courses_task_id_position_key" UNIQUE ("task_id", "position");



ALTER TABLE ONLY "public"."task_learners"
    ADD CONSTRAINT "task_learners_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_learners"
    ADD CONSTRAINT "task_learners_task_id_student_id_key" UNIQUE ("task_id", "student_id");



ALTER TABLE ONLY "public"."task_learning_events"
    ADD CONSTRAINT "task_learning_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_learning_events"
    ADD CONSTRAINT "task_learning_events_task_id_student_id_client_event_id_key" UNIQUE ("task_id", "student_id", "client_event_id");



CREATE INDEX "ai_intervention_suggestions_task_created_idx" ON "public"."ai_intervention_suggestions" USING "btree" ("task_id", "created_at" DESC);



CREATE INDEX "ai_learning_summaries_task_created_idx" ON "public"."ai_learning_summaries" USING "btree" ("task_id", "created_at" DESC);



CREATE INDEX "course_assignments_course_id_idx" ON "public"."course_assignments" USING "btree" ("course_id");



CREATE INDEX "course_assignments_student_id_idx" ON "public"."course_assignments" USING "btree" ("student_id");



CREATE INDEX "course_progress_events_course_id_idx" ON "public"."course_progress_events" USING "btree" ("course_id", "created_at" DESC);



CREATE INDEX "course_progress_events_student_id_idx" ON "public"."course_progress_events" USING "btree" ("student_id", "created_at" DESC);



CREATE UNIQUE INDEX "course_revoice_jobs_one_active_per_course_idx" ON "public"."course_revoice_jobs" USING "btree" ("course_id") WHERE ("status" = ANY (ARRAY['queued'::"text", 'running'::"text"]));



CREATE INDEX "course_revoice_jobs_owner_idx" ON "public"."course_revoice_jobs" USING "btree" ("requested_by", "course_id", "created_at" DESC);



CREATE INDEX "course_revoice_jobs_pending_idx" ON "public"."course_revoice_jobs" USING "btree" ("status", "created_at") WHERE ("status" = ANY (ARRAY['queued'::"text", 'running'::"text"]));



CREATE INDEX "courses_created_by_idx" ON "public"."courses" USING "btree" ("created_by") WHERE ("created_by" IS NOT NULL);



CREATE INDEX "idx_courses_created_at" ON "public"."courses" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_courses_created_by" ON "public"."courses" USING "btree" ("created_by");



CREATE INDEX "learning_tasks_course_id_idx" ON "public"."learning_tasks" USING "btree" ("course_id", "created_at" DESC);



CREATE INDEX "learning_tasks_created_by_idx" ON "public"."learning_tasks" USING "btree" ("created_by", "status", "created_at" DESC);



CREATE INDEX "runtime_records_by_session_scene" ON "public"."runtime_records" USING "btree" ("session_id", "scene_id") WHERE ("scene_id" IS NOT NULL);



CREATE UNIQUE INDEX "runtime_records_id_unique" ON "public"."runtime_records" USING "btree" ("id");



CREATE INDEX "runtime_sessions_by_learner" ON "public"."runtime_sessions" USING "btree" ("learner_key");



CREATE INDEX "runtime_sessions_by_stage" ON "public"."runtime_sessions" USING "btree" ("stage_id");



CREATE INDEX "runtime_sessions_by_stage_learner" ON "public"."runtime_sessions" USING "btree" ("stage_id", "learner_key", "created_at", "id");



CREATE UNIQUE INDEX "students_access_code_unique" ON "public"."students" USING "btree" ("access_code");



CREATE UNIQUE INDEX "students_email_unique" ON "public"."students" USING "btree" ("email");



CREATE UNIQUE INDEX "students_employee_no_unique" ON "public"."students" USING "btree" ("employee_no");



CREATE UNIQUE INDEX "students_user_id_unique" ON "public"."students" USING "btree" ("user_id") WHERE ("user_id" IS NOT NULL);



CREATE INDEX "task_course_progress_task_course_idx" ON "public"."task_course_progress" USING "btree" ("task_id", "course_id");



CREATE INDEX "task_courses_course_idx" ON "public"."task_courses" USING "btree" ("course_id");



CREATE INDEX "task_courses_task_position_idx" ON "public"."task_courses" USING "btree" ("task_id", "position");



CREATE INDEX "task_learners_student_task_idx" ON "public"."task_learners" USING "btree" ("student_id", "task_id");



CREATE INDEX "task_learning_events_task_course_student_idx" ON "public"."task_learning_events" USING "btree" ("task_id", "course_id", "student_id", "created_at");



CREATE INDEX "task_learning_events_task_student_idx" ON "public"."task_learning_events" USING "btree" ("task_id", "student_id", "created_at");



CREATE OR REPLACE TRIGGER "courses_updated_at" BEFORE UPDATE ON "public"."courses" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "create_task_course_progress_on_assignment" AFTER INSERT ON "public"."task_learners" FOR EACH ROW EXECUTE FUNCTION "public"."create_task_course_progress_for_learner"();



CREATE OR REPLACE TRIGGER "enforce_learning_tasks_immutability" BEFORE UPDATE ON "public"."learning_tasks" FOR EACH ROW EXECUTE FUNCTION "public"."check_learning_tasks_immutability"();



CREATE OR REPLACE TRIGGER "enforce_task_courses_frozen" BEFORE INSERT OR DELETE OR UPDATE ON "public"."task_courses" FOR EACH ROW EXECUTE FUNCTION "public"."check_task_courses_frozen"();



CREATE OR REPLACE TRIGGER "enforce_task_learners_frozen" BEFORE INSERT OR DELETE ON "public"."task_learners" FOR EACH ROW EXECUTE FUNCTION "public"."check_task_learners_frozen"();



CREATE OR REPLACE TRIGGER "prevent_snapshot_delete" BEFORE DELETE ON "public"."course_snapshots" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_snapshot_modification"();



CREATE OR REPLACE TRIGGER "prevent_snapshot_update" BEFORE UPDATE ON "public"."course_snapshots" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_snapshot_modification"();



CREATE OR REPLACE TRIGGER "sync_staff_learning_identity" AFTER INSERT OR UPDATE OF "role", "display_name", "disabled_at" ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."sync_staff_learning_identity"();



CREATE OR REPLACE TRIGGER "touch_ai_intervention_updated_at" BEFORE UPDATE ON "public"."ai_intervention_suggestions" FOR EACH ROW EXECUTE FUNCTION "public"."touch_ai_intervention_updated_at"();



CREATE OR REPLACE TRIGGER "touch_course_assignments_updated_at" BEFORE UPDATE ON "public"."course_assignments" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "touch_learning_tasks_updated_at" BEFORE UPDATE ON "public"."learning_tasks" FOR EACH ROW EXECUTE FUNCTION "public"."touch_task_updated_at"();



CREATE OR REPLACE TRIGGER "touch_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "touch_students_updated_at" BEFORE UPDATE ON "public"."students" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "touch_task_learners_updated_at" BEFORE UPDATE ON "public"."task_learners" FOR EACH ROW EXECUTE FUNCTION "public"."touch_task_updated_at"();



ALTER TABLE ONLY "public"."ai_intervention_suggestions"
    ADD CONSTRAINT "ai_intervention_suggestions_created_task_id_fkey" FOREIGN KEY ("created_task_id") REFERENCES "public"."learning_tasks"("id");



ALTER TABLE ONLY "public"."ai_intervention_suggestions"
    ADD CONSTRAINT "ai_intervention_suggestions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."learning_tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_learning_summaries"
    ADD CONSTRAINT "ai_learning_summaries_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_learning_summaries"
    ADD CONSTRAINT "ai_learning_summaries_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."learning_tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."course_assignments"
    ADD CONSTRAINT "course_assignments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."course_progress_events"
    ADD CONSTRAINT "course_progress_events_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "public"."course_assignments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."course_progress_events"
    ADD CONSTRAINT "course_progress_events_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."course_revoice_jobs"
    ADD CONSTRAINT "course_revoice_jobs_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."course_snapshots"
    ADD CONSTRAINT "course_snapshots_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."course_snapshots"
    ADD CONSTRAINT "course_snapshots_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."learning_tasks"
    ADD CONSTRAINT "learning_tasks_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id");



ALTER TABLE ONLY "public"."learning_tasks"
    ADD CONSTRAINT "learning_tasks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."learning_tasks"
    ADD CONSTRAINT "learning_tasks_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "public"."course_snapshots"("id");



ALTER TABLE ONLY "public"."learning_tasks"
    ADD CONSTRAINT "learning_tasks_source_task_id_fkey" FOREIGN KEY ("source_task_id") REFERENCES "public"."learning_tasks"("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."runtime_records"
    ADD CONSTRAINT "runtime_records_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."runtime_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."students"
    ADD CONSTRAINT "students_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."task_course_progress"
    ADD CONSTRAINT "task_course_progress_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id");



ALTER TABLE ONLY "public"."task_course_progress"
    ADD CONSTRAINT "task_course_progress_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_course_progress"
    ADD CONSTRAINT "task_course_progress_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."learning_tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_courses"
    ADD CONSTRAINT "task_courses_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id");



ALTER TABLE ONLY "public"."task_courses"
    ADD CONSTRAINT "task_courses_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "public"."course_snapshots"("id");



ALTER TABLE ONLY "public"."task_courses"
    ADD CONSTRAINT "task_courses_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."learning_tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_learners"
    ADD CONSTRAINT "task_learners_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id");



ALTER TABLE ONLY "public"."task_learners"
    ADD CONSTRAINT "task_learners_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."learning_tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_learning_events"
    ADD CONSTRAINT "task_learning_events_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id");



ALTER TABLE ONLY "public"."task_learning_events"
    ADD CONSTRAINT "task_learning_events_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_learning_events"
    ADD CONSTRAINT "task_learning_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."learning_tasks"("id") ON DELETE CASCADE;



CREATE POLICY "Allow all access for anon" ON "public"."courses" USING (true) WITH CHECK (true);



CREATE POLICY "Allow anon insert assignments" ON "public"."course_assignments" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "Allow anon insert events" ON "public"."course_progress_events" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "Allow anon insert students" ON "public"."students" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "Allow anon update assignments" ON "public"."course_assignments" FOR UPDATE TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "Allow anon update students" ON "public"."students" FOR UPDATE TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "Allow authenticated read courses" ON "public"."courses" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated can read own learner records" ON "public"."task_learners" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."students" "s"
  WHERE (("s"."id" = "task_learners"."student_id") AND ("s"."user_id" = "auth"."uid"())))));



CREATE POLICY "Authenticated can read own published tasks" ON "public"."learning_tasks" FOR SELECT TO "authenticated" USING ((("status" = 'published'::"text") AND (EXISTS ( SELECT 1
   FROM ("public"."task_learners" "tl"
     JOIN "public"."students" "s" ON (("s"."id" = "tl"."student_id")))
  WHERE (("tl"."task_id" = "learning_tasks"."id") AND ("s"."user_id" = "auth"."uid"()))))));



CREATE POLICY "Learners can read own assignments" ON "public"."course_assignments" FOR SELECT TO "authenticated" USING (("student_id" = "auth"."uid"()));



CREATE POLICY "Owners can read their revoice jobs" ON "public"."course_revoice_jobs" FOR SELECT USING ((("auth"."uid"())::"text" = "requested_by"));



CREATE POLICY "Profiles are readable by signed in users" ON "public"."profiles" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Teachers can read all assignments" ON "public"."course_assignments" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['teacher'::"text", 'admin'::"text"]))))));



CREATE POLICY "Users can insert own profile" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "id")) WITH CHECK (("auth"."uid"() = "id"));



ALTER TABLE "public"."ai_intervention_suggestions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_learning_summaries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."course_assignments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."course_progress_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."course_revoice_jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."course_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."courses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."learning_tasks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."runtime_merge_grants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."runtime_records" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "runtime_records_self" ON "public"."runtime_records" USING ((EXISTS ( SELECT 1
   FROM "public"."runtime_sessions" "s"
  WHERE (("s"."id" = "runtime_records"."session_id") AND ("s"."learner_key" = ("auth"."uid"())::"text")))));



ALTER TABLE "public"."runtime_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "runtime_sessions_self" ON "public"."runtime_sessions" USING (("learner_key" = ("auth"."uid"())::"text")) WITH CHECK (("learner_key" = ("auth"."uid"())::"text"));



ALTER TABLE "public"."students" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."task_course_progress" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."task_courses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."task_learners" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."task_learning_events" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."add_task_learners"("p_task_id" "uuid", "p_learner_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."add_task_learners"("p_task_id" "uuid", "p_learner_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."check_learning_tasks_immutability"() TO "anon";
GRANT ALL ON FUNCTION "public"."check_learning_tasks_immutability"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_learning_tasks_immutability"() TO "service_role";



GRANT ALL ON FUNCTION "public"."check_task_courses_frozen"() TO "anon";
GRANT ALL ON FUNCTION "public"."check_task_courses_frozen"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_task_courses_frozen"() TO "service_role";



GRANT ALL ON FUNCTION "public"."check_task_learners_frozen"() TO "anon";
GRANT ALL ON FUNCTION "public"."check_task_learners_frozen"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_task_learners_frozen"() TO "service_role";



GRANT ALL ON TABLE "public"."course_revoice_jobs" TO "anon";
GRANT ALL ON TABLE "public"."course_revoice_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."course_revoice_jobs" TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_course_revoice_job"("p_job_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_course_revoice_job"("p_job_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."claim_course_revoice_job"("p_job_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_course_revoice_job"("p_job_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."commit_course_revoice_job"("p_job_id" "text", "p_course_id" "text", "p_source_updated_at" timestamp with time zone, "p_course_data" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."commit_course_revoice_job"("p_job_id" "text", "p_course_id" "text", "p_source_updated_at" timestamp with time zone, "p_course_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."commit_course_revoice_job"("p_job_id" "text", "p_course_id" "text", "p_source_updated_at" timestamp with time zone, "p_course_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."commit_course_revoice_job"("p_job_id" "text", "p_course_id" "text", "p_source_updated_at" timestamp with time zone, "p_course_data" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."count_task_learners"("p_task_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."count_task_learners"("p_task_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."create_task_course_progress_for_learner"() TO "anon";
GRANT ALL ON FUNCTION "public"."create_task_course_progress_for_learner"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_task_course_progress_for_learner"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_task_with_learners"("p_course_id" "text", "p_title" "text", "p_description" "text", "p_created_by" "uuid", "p_task_type" "text", "p_source_task_id" "uuid", "p_start_at" timestamp with time zone, "p_due_at" timestamp with time zone, "p_learner_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_task_with_learners"("p_course_id" "text", "p_title" "text", "p_description" "text", "p_created_by" "uuid", "p_task_type" "text", "p_source_task_id" "uuid", "p_start_at" timestamp with time zone, "p_due_at" timestamp with time zone, "p_learner_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_snapshot_modification"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_snapshot_modification"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_snapshot_modification"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."publish_task"("p_task_id" "uuid", "p_user_id" "uuid", "p_source_hash" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."publish_task"("p_task_id" "uuid", "p_user_id" "uuid", "p_source_hash" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."publish_task_course_package"("p_task_id" "uuid", "p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."publish_task_course_package"("p_task_id" "uuid", "p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_task_courses"("p_task_id" "uuid", "p_course_ids" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_task_courses"("p_task_id" "uuid", "p_course_ids" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_task_learners"("p_task_id" "uuid", "p_learner_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_task_learners"("p_task_id" "uuid", "p_learner_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."runtime_append_record"("p_session_id" "text", "p_id" "text", "p_scene_id" "text", "p_action_index" integer, "p_sub_anchor" "text", "p_created_at" "text", "p_payload" "text", "p_expect_revision" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."runtime_append_record"("p_session_id" "text", "p_id" "text", "p_scene_id" "text", "p_action_index" integer, "p_sub_anchor" "text", "p_created_at" "text", "p_payload" "text", "p_expect_revision" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."runtime_create_session"("p_id" "text", "p_version" "text", "p_kind" "text", "p_stage_id" "text", "p_learner_key" "text", "p_status" "text", "p_created_at" "text", "p_updated_at" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."runtime_create_session"("p_id" "text", "p_version" "text", "p_kind" "text", "p_stage_id" "text", "p_learner_key" "text", "p_status" "text", "p_created_at" "text", "p_updated_at" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."runtime_delete_learner_runtime"("p_stage_id" "text", "p_learner_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."runtime_delete_learner_runtime"("p_stage_id" "text", "p_learner_key" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."runtime_delete_session"("p_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."runtime_delete_session"("p_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."runtime_delete_stage_runtime"("p_stage_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."runtime_delete_stage_runtime"("p_stage_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."runtime_get_record"("p_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."runtime_get_record"("p_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."runtime_get_session"("p_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."runtime_get_session"("p_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."runtime_list_records"("p_session_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."runtime_list_records"("p_session_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."runtime_list_records_by_scene"("p_session_id" "text", "p_scene_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."runtime_list_records_by_scene"("p_session_id" "text", "p_scene_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."runtime_list_sessions"("p_stage_id" "text", "p_learner_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."runtime_list_sessions"("p_stage_id" "text", "p_learner_key" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."runtime_list_sessions_by_learner"("p_learner_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."runtime_list_sessions_by_learner"("p_learner_key" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."runtime_merge_learner"("p_from" "text", "p_to" "text", "p_expect_version" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."runtime_merge_learner"("p_from" "text", "p_to" "text", "p_expect_version" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."runtime_merge_with_grant"("p_grant_id" "text", "p_from" "text", "p_to" "text", "p_expect_version" "text", "p_now" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."runtime_merge_with_grant"("p_grant_id" "text", "p_from" "text", "p_to" "text", "p_expect_version" "text", "p_now" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."runtime_update_session"("p_id" "text", "p_version" "text", "p_kind" "text", "p_stage_id" "text", "p_learner_key" "text", "p_status" "text", "p_created_at" "text", "p_updated_at" "text", "p_expect_revision" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."runtime_update_session"("p_id" "text", "p_version" "text", "p_kind" "text", "p_stage_id" "text", "p_learner_key" "text", "p_status" "text", "p_created_at" "text", "p_updated_at" "text", "p_expect_revision" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_staff_learning_identity"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_staff_learning_identity"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_staff_learning_identity"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_ai_intervention_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_ai_intervention_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_ai_intervention_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_task_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_task_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_task_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."upgrade_seed_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."upgrade_seed_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."upgrade_seed_admin"() TO "service_role";



GRANT ALL ON TABLE "public"."ai_intervention_suggestions" TO "service_role";



GRANT ALL ON TABLE "public"."ai_learning_summaries" TO "service_role";



GRANT ALL ON TABLE "public"."course_assignments" TO "anon";
GRANT ALL ON TABLE "public"."course_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."course_assignments" TO "service_role";



GRANT ALL ON TABLE "public"."course_progress_events" TO "anon";
GRANT ALL ON TABLE "public"."course_progress_events" TO "authenticated";
GRANT ALL ON TABLE "public"."course_progress_events" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."course_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."course_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."courses" TO "anon";
GRANT ALL ON TABLE "public"."courses" TO "authenticated";
GRANT ALL ON TABLE "public"."courses" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."learning_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."learning_tasks" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."runtime_merge_grants" TO "anon";
GRANT ALL ON TABLE "public"."runtime_merge_grants" TO "authenticated";
GRANT ALL ON TABLE "public"."runtime_merge_grants" TO "service_role";



GRANT ALL ON TABLE "public"."runtime_records" TO "anon";
GRANT ALL ON TABLE "public"."runtime_records" TO "authenticated";
GRANT ALL ON TABLE "public"."runtime_records" TO "service_role";



GRANT ALL ON TABLE "public"."runtime_sessions" TO "anon";
GRANT ALL ON TABLE "public"."runtime_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."runtime_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."students" TO "anon";
GRANT ALL ON TABLE "public"."students" TO "authenticated";
GRANT ALL ON TABLE "public"."students" TO "service_role";



GRANT ALL ON TABLE "public"."task_course_progress" TO "service_role";



GRANT ALL ON TABLE "public"."task_courses" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."task_learners" TO "authenticated";
GRANT ALL ON TABLE "public"."task_learners" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."task_learning_events" TO "authenticated";
GRANT ALL ON TABLE "public"."task_learning_events" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







