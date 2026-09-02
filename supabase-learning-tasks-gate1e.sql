-- Gate 1E: AI learning brief and teacher-confirmed remediation drafts.
-- Apply after supabase-learning-tasks-v1.sql and supabase-learning-tasks-gate1c.sql.

create table if not exists public.ai_learning_summaries (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.learning_tasks(id) on delete cascade,
  scope text not null check (scope in ('class', 'learner')),
  student_id uuid references public.students(id) on delete cascade,
  content jsonb not null,
  model text not null,
  prompt_version text not null default 'gate1e-v1',
  data_version text not null,
  created_at timestamptz not null default now(),
  check ((scope = 'class' and student_id is null) or (scope = 'learner' and student_id is not null))
);

create index if not exists ai_learning_summaries_task_created_idx
  on public.ai_learning_summaries(task_id, created_at desc);

create table if not exists public.ai_intervention_suggestions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.learning_tasks(id) on delete cascade,
  learner_ids uuid[] not null,
  scene_ids text[] not null default array[]::text[],
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'ignored')),
  created_task_id uuid references public.learning_tasks(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_intervention_suggestions_task_created_idx
  on public.ai_intervention_suggestions(task_id, created_at desc);

alter table public.ai_learning_summaries enable row level security;
alter table public.ai_intervention_suggestions enable row level security;
revoke all on public.ai_learning_summaries from anon, authenticated;
revoke all on public.ai_intervention_suggestions from anon, authenticated;

create or replace function public.touch_ai_intervention_updated_at()
returns trigger as $$ begin new.updated_at = now(); return new; end; $$ language plpgsql;

drop trigger if exists touch_ai_intervention_updated_at on public.ai_intervention_suggestions;
create trigger touch_ai_intervention_updated_at
before update on public.ai_intervention_suggestions
for each row execute function public.touch_ai_intervention_updated_at();
