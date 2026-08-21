-- Gate 2I: align per-course progress storage with the learning-event aggregator.
-- Run after supabase-learning-tasks-gate2b.sql.

alter table public.task_course_progress
  add column if not exists completed_scene_count integer not null default 0,
  add column if not exists total_scene_count integer not null default 0,
  add column if not exists last_scene_id text,
  add column if not exists mastery_percent numeric;

-- Surface historical learning immediately. The next learning event also rebuilds
-- each learner's progress and completion from the complete event history.
with activity as (
  select
    task_id,
    student_id,
    course_id,
    min(created_at) as first_seen_at,
    max(created_at) as last_seen_at,
    coalesce(sum(case when event_type = 'heartbeat' then (payload ->> 'activeSeconds')::integer else 0 end), 0)::integer as effective_seconds
  from public.task_learning_events
  where course_id is not null
  group by task_id, student_id, course_id
)
update public.task_course_progress progress
set
  status = case when progress.status = 'completed' then 'completed' else 'in_progress' end,
  started_at = coalesce(progress.started_at, activity.first_seen_at),
  last_seen_at = greatest(coalesce(progress.last_seen_at, activity.last_seen_at), activity.last_seen_at),
  effective_seconds = greatest(progress.effective_seconds, activity.effective_seconds)
from activity
where progress.task_id = activity.task_id
  and progress.student_id = activity.student_id
  and progress.course_id = activity.course_id;

with activity as (
  select
    task_id,
    student_id,
    min(created_at) as first_seen_at,
    max(created_at) as last_seen_at,
    coalesce(sum(case when event_type = 'heartbeat' then (payload ->> 'activeSeconds')::integer else 0 end), 0)::integer as effective_seconds
  from public.task_learning_events
  group by task_id, student_id
)
update public.task_learners learner
set
  status = case when learner.status = 'completed' then 'completed' else 'in_progress' end,
  started_at = coalesce(learner.started_at, activity.first_seen_at),
  last_seen_at = greatest(coalesce(learner.last_seen_at, activity.last_seen_at), activity.last_seen_at),
  effective_seconds = greatest(learner.effective_seconds, activity.effective_seconds)
from activity
where learner.task_id = activity.task_id
  and learner.student_id = activity.student_id;
