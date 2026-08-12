# Gate 1A 数据库迁移回滚说明

## 影响范围

迁移文件 `supabase-learning-tasks-v1.sql` 新增三张表，均支持 SAFE DROP 回滚。

## 回滚顺序（逆依赖序）

```sql
-- 1. 最内层表（引用 task，被 learning_tasks 引用）
drop table if exists public.task_learners cascade;

-- 2. 核心表（引用 courses 和 course_snapshots）
drop table if exists public.learning_tasks cascade;

-- 3. 快照表（被 learning_tasks 引用）
drop table if exists public.course_snapshots cascade;

-- 4. 触发器和函数
drop trigger if exists touch_learning_tasks_updated_at on public.learning_tasks;
drop trigger if exists touch_task_learners_updated_at on public.task_learners;
drop function if exists public.touch_task_updated_at();
```

## 注意事项

1. **不回滚 RLS 策略**：`drop policy` 需在 drop table 之前执行，但 `drop table cascade` 会自动清理关联策略。
2. **不自动放入迁移**：本说明仅供运维参考，迁移文件本身不含 DROP。
3. **数据安全**：`drop table cascade` 会删除所有任务和进度数据。如生产已有数据，先 `pg_dump` 备份相关表。
4. **幂等性**：迁移文件为幂等设计（`create if not exists`），重复执行不会报错。
5. **回滚后影响**：所有学习任务、进度数据将不可用；课程本身不受影响（在 `courses` 表中）。
