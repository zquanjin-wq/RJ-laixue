# 学习管理与 AI 教学闭环：进度与交接

日期：2026-08-13  
当前主线：Gate 2E（教学驾驶舱与数据中心）

## 已完成

1. 任务闭环：任务创建、发布、名单、分享链接、发布时课程快照、学员任务列表、PC/移动端任务学习入口。
2. 进度闭环：任务学习事件、有效时长、完成度与掌握度分离、任务与课程包进度。
3. 管理闭环：任务总体、课程组合进度、学员明细、AI 简报与经教师确认的补学草稿。
4. 身份模型：教师/管理员同时拥有学习身份，可在同一学员名单中被分配任务；教师保有其创建和管理权限。
5. 多课程任务：一个任务可组合多门课程；课程可被多个任务复用；任务与课程数据口径分离。
6. 驾驶舱：课程管理、学习任务、AI 创课、任务数据看板及 AI 数据问答已接入。
7. 数据中心双视图：
   - 任务运营：任务总体、课程组合、学员关注项；
   - 课程资产：课程跨任务使用、学习人数、完成率、时长；进入课程页后查看章节分析。

## 已执行的生产 SQL

- `supabase-learning-tasks-v1.sql`
- `supabase-learning-tasks-gate1c.sql`
- `supabase-learning-tasks-gate1e.sql`
- `supabase-learning-tasks-gate1f.sql`
- `supabase-learning-tasks-gate2a.sql`
- `supabase-learning-tasks-gate2b.sql`
- `supabase-learning-tasks-gate2g-staff-learners.sql`

## 当前待处理的紧急项

`publish_task_course_package` 在生产环境的 token 生成漏用了 `extensions.` schema 前缀。热修复文件已生成但尚未确认执行：

- `supabase-learning-tasks-gate2b-publish-hotfix.sql`

执行后，可再次发布原草稿任务；它不会重建任务或名单。

## 当前未提交的工作区内容

本次 2E 第二项将涉及：

- `app/api/admin/course-analytics/route.ts`
- `components/course-analytics-board.tsx`
- `components/teaching-data-board.tsx`
- `tests/api/course-analytics.test.ts`
- 本交接报告

发布热修复相关文件应独立提交，勿与 2E 混合：

- `supabase-learning-tasks-gate2b.sql`
- `supabase-learning-tasks-gate2b-publish-hotfix.sql`
- `tests/api/learning-task-course-package-publish-hotfix.test.ts`

此外工作区存在多份 `.tmp-*`、`docs/user-guide/`、`scripts/tmp-bootstrap-pg.mjs` 等无关未跟踪内容，提交时不要纳入。

## 主线剩余工作

优先级按建议排序：

1. 完成 2E 验收：推送数据中心双视图，浏览器冒烟验证权限范围、课程跳转和 AI 数据问答。
2. 修复并回归任务发布热修复：确认 SQL 已执行，发布一个任务并用已分配的教师/学员分别进入。
3. 课程管理增强：在课程列表中显式提供“数据分析”入口，减少用户需要从数据中心跳转的成本。
4. 任务运营增强：任务列表筛选、搜索、导出，以及更清晰的到期/补学操作入口。
5. 课程级 AI 分析（可选后续）：只以课程跨任务数据和章节数据作解释，不与任务运营 AI 混用。
6. 稳定性收口：一次完整手工冒烟（新建任务、发布、分享、学习、回看任务/课程数据、AI 简报/问答）。

## 已确立的产品边界

- 课程是内容资产：由创建老师管理，跨任务汇总其使用和学习表现，章节/PPT 分析在课程域。
- 任务是培训运营单元：可组合课程，关注任务完成率、学习率、学员与课程组合进度；不展示逐页 PPT 详情。
- AI 只能解释当前权限范围内的确定性数据；不编造数据，不自动发布补学任务。
- 教师是具备管理权限的学员，不需要在任务名单另分“老师组”。
- 不新增哈希/SHA-256，不做超出实际风险的防御式设计。
