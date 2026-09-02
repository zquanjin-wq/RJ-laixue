-- Gate 1C: task learning facts and lightweight progress aggregation.
-- Apply after supabase-learning-tasks-v1.sql. Do not run this file in production from Codex.

create table if not exists public.task_learning_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.learning_tasks(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  client_event_id text not null,
  event_type text not null check (event_type in (
    'task_opened', 'scene_started', 'scene_completed', 'heartbeat',
    'question_asked', 'check_submitted', 'check_reviewed', 'task_completed'
  )),
  scene_id text,
  scene_order integer,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(task_id, student_id, client_event_id)
);

create index if not exists task_learning_events_task_student_idx
  on public.task_learning_events(task_id, student_id, created_at);

alter table public.task_learning_events enable row level security;
revoke all on public.task_learning_events from anon;
revoke insert, update, delete on public.task_learning_events from authenticated;

alter table public.task_learners
  add column if not exists mastery_percent numeric,
  add column if not exists completion_requested_at timestamptz;
