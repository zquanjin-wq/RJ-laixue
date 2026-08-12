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
