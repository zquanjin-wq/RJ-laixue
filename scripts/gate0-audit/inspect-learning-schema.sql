-- ============================================================
-- Gate 0 学习数据模型只读探针
-- 用途：验证学习表结构、RLS 策略、约束是否与盘点报告一致
-- 执行方式：在 Supabase SQL Editor 中以只读方式运行
-- 注意：本脚本不修改任何数据
-- ============================================================

-- 1. 学习表结构概览
select
  table_name,
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('students', 'course_assignments', 'course_progress_events', 'courses')
order by table_name, ordinal_position;

-- 2. course_progress_events 的 event_type 检查约束
select
  conrelid::regclass as table_name,
  conname as constraint_name,
  pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid in (
  'public.course_progress_events'::regclass
)
  and contype = 'c';

-- 3. 学习表上的索引
select
  schemaname,
  tablename,
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('students', 'course_assignments', 'course_progress_events')
order by tablename, indexname;

-- 4. 学习表 RLS 策略（确认 anon 是否还有残留权限）
select
  tablename,
  policyname,
  cmd,
  roles,
  qual::text as using_expression,
  with_check::text as with_check_expression
from pg_policies
where schemaname = 'public'
  and tablename in ('students', 'course_assignments', 'course_progress_events', 'courses')
order by tablename, cmd, policyname;

-- 5. 验证 anon 角色对学习表是否还有任何权限
select
  grantee,
  table_name,
  privilege_type
from information_schema.table_privileges
where grantee = 'anon'
  and table_schema = 'public'
  and table_name in ('students', 'course_assignments', 'course_progress_events', 'courses')
order by table_name, privilege_type;

-- 6. 学习事件统计（最近 30 天，用于确认事件字典实际使用情况）
select
  event_type,
  count(*) as event_count,
  min(created_at) as first_seen,
  max(created_at) as last_seen,
  count(distinct student_id) as distinct_students,
  count(distinct course_id) as distinct_courses
from public.course_progress_events
where created_at > now() - interval '30 days'
group by event_type
order by event_count desc;

-- 7. 每门课程的事件类型分布（Top 20）
select
  course_id,
  event_type,
  count(*) as event_count
from public.course_progress_events
where created_at > now() - interval '30 days'
group by course_id, event_type
order by event_count desc
limit 20;
