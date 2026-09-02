-- Durable server-side course revoice queue.
-- Apply after the existing courses schema migrations.

create table if not exists public.course_revoice_jobs (
  id text primary key,
  course_id text not null references public.courses(id) on delete cascade,
  requested_by text not null,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'conflict')),
  voice jsonb not null,
  snapshot jsonb not null,
  source_updated_at timestamptz not null,
  items jsonb not null default '[]'::jsonb,
  total_items integer not null default 0,
  completed_items integer not null default 0,
  failed_items integer not null default 0,
  message text not null default '',
  error text,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists course_revoice_jobs_pending_idx
  on public.course_revoice_jobs (status, created_at)
  where status in ('queued', 'running');
create index if not exists course_revoice_jobs_owner_idx
  on public.course_revoice_jobs (requested_by, course_id, created_at desc);
-- Older deployments briefly allowed concurrent active rows. Keep the newest
-- one active and close the rest before installing the invariant.
with ranked_active as (
  select id,
         row_number() over (partition by course_id order by created_at desc, id desc) as rn
  from public.course_revoice_jobs
  where status in ('queued', 'running')
)
update public.course_revoice_jobs j
set status = 'cancelled',
    message = '已由较新的重新配音任务取代',
    completed_at = now(),
    locked_until = null,
    updated_at = now()
from ranked_active r
where j.id = r.id and r.rn > 1;
create unique index if not exists course_revoice_jobs_one_active_per_course_idx
  on public.course_revoice_jobs (course_id)
  where status in ('queued', 'running');

alter table public.course_revoice_jobs enable row level security;

drop policy if exists "Owners can read their revoice jobs" on public.course_revoice_jobs;
create policy "Owners can read their revoice jobs"
  on public.course_revoice_jobs for select
  using (auth.uid()::text = requested_by);

-- Atomically reserve one unfinished job. Service-role workers call this RPC;
-- ordinary clients never receive write access to the queue table.
create or replace function public.claim_course_revoice_job(p_job_id text)
returns setof public.course_revoice_jobs
language plpgsql
security definer
set search_path = public
as $$
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

revoke all on function public.claim_course_revoice_job(text) from public;

-- Commit is all-or-nothing: a cancelled job can never update the course, and
-- an edited course can never be overwritten by an old snapshot.
create or replace function public.commit_course_revoice_job(
  p_job_id text,
  p_course_id text,
  p_source_updated_at timestamptz,
  p_course_data jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
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

revoke all on function public.commit_course_revoice_job(text, text, timestamptz, jsonb) from public;
