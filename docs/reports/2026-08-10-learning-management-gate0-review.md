# Gate 0 验收复核与架构裁决

> 复核日期：2026-08-10  
> 复核人：Codex  
> 结论：通过（Gate 0.1 修订已于 2026-08-10 复验通过）

## 0. 最终签字

Gate 0.1 已修正 PC 事件调用、RuntimeStore 表结构和课程快照数据层级三项证据错误；Windows CLI 直接执行判断亦已修复。

复验结果：

- 课程快照测试：11/11 通过；
- `tsc --noEmit`：通过；
- 相关文件 Prettier 检查：通过；
- Windows CLI 无参数运行：正确输出 Usage，退出码 1；
- 未修改业务代码、数据库 schema，未执行生产写入。

Gate 0 正式关闭，准许进入 Gate 0.5 身份可信修复。

## 1. 已确认且可采纳的结论

- PC 当前只在特定分享模式记录粗粒度学习事件，且末页完成口径不可靠；
- 移动端进度和提问计数仍在 `localStorage`，不能支持可信的跨端管理统计；
- AI 对话与检查题服务端持久化依赖 shadow/outbox 开关，不能直接视为稳定生产事实源；
- 检查题存在稳定 question ID 和评分结果结构，题目与内容节点可通过承载它的 `sceneId` 关联；
- 客户端 `studentId` 被服务端信任是高风险缺陷；
- 正式学习任务必须与自由浏览分离，并在发布时冻结课程结构。

## 2. 阻止 Gate 0 通过的证据错误

### 2.1 PC `view_scene` 结论不成立

`app/classroom/[id]/page.tsx` 当前只有 `open_course` 和 `complete_course` 两个 `recordLearningEvent` 调用点。报告所称 PC 已发送 `view_scene` 缺少代码证据，应改为“事件类型受 API 支持，但当前页面没有发送调用”。

### 2.2 RuntimeStore 表结构描述错误

以 `supabase-runtime-store-v1.sql` 为准：

- `runtime_sessions.id` 是 `text`；
- `runtime_records.id` 是 `text`；
- `runtime_sessions` 有 `kind`；
- `runtime_records` 没有 `kind`，其语义由父 session 的 kind 决定。

因此后续查询不能写成 `runtime_records.kind = ...`，必须关联 `runtime_sessions`，或经 RuntimeStore API 按 session 读取。

### 2.3 课程快照探针读取了错误的数据层级

`lib/utils/cloud-sync.ts` 写入 `courses.data` 的结构为：

```ts
{ stage, scenes, outlines }
```

当前 `inspect-course-snapshot.ts` 把 `course.data` 整体当作 `Stage`，并从 `stage.scenes`、`stage.outlines` 读取。这会让真实课程快照产生空场景或错误章节推断。探针必须按真实 `PersistedClassroomData` 结构读取，并优先复用仓库已有类型/解析逻辑。

### 2.4 “只读 SQL 探针”尚未形成实际生产证据

报告明确说明未操作生产数据，因此关于“生产实际事件分布、生产实际 RLS、shadow 开关是否开启”的结论只能标记为代码/迁移静态结论，不能写成已验证的生产事实。SQL 探针保留，但需在报告中区分：

- 静态代码事实；
- 待在 Supabase 执行验证；
- 已获得的脱敏运行结果。

## 3. 四项正式架构裁决

### D1：事件字典有条件采纳，但改为两层事件模型

不把所有细粒度数据同时塞进 `course_progress_events` 和 RuntimeStore，避免双事实源。

**业务学习事件层**用于任务统计：

- `task_opened`
- `learning_started`
- `scene_entered`
- `scene_completed`
- `heartbeat`
- `learning_paused`
- `learning_resumed`
- `question_asked`
- `check_submitted`
- `check_reviewed`
- `task_completed`

**RuntimeStore 细粒度记录层**继续承载 chat、quizAttempt、playback 原始记录。业务事件保存引用 ID 和聚合所需最小字段，不复制完整聊天或完整答题 payload。

历史 `open_course/view_scene/complete_course` 保留只读兼容，不作为新任务的主口径。正式表名和迁移方式在 Gate 1 数据设计中冻结。

### D2：完成采用显式动作，但“检查题通过”不是统一完成条件

首版采用“显式点击完成学习 + 确定性前置检查”：

- 必学 scene 均已完成；
- 必做检查题均已提交；
- 需要异步 AI 批改的题目已完成 review；
- 学员点击“完成学习”。

不要求所有检查题答对。完成度和掌握度必须分离：答错可以完成学习，但会进入个人小结和补学建议。未来如需考试型任务，再增加可配置的及格阈值。

### D3：移动端必须在第一阶段接入统一服务端进度

不能只建设服务端、把移动端留到以后。移动端是实际学习入口，若缺失，第一阶段的“谁学了、学多少”仍不可信。

实施可以排在任务/服务端能力之后，但必须在 Gate 2 可信进度验收前完成。`localStorage` 保留为弱网缓存，不再作为事实源。

### D4：立即安排 Gate 0.5 修复 `studentId` 信任问题

这是后续所有统计可信度的安全前提，优先于 Gate 1 新功能。

修复原则：

- API 必须读取 Supabase 登录态；
- 服务端通过 `students.user_id = auth.uid()` 解析 student；
- 客户端提交的 `studentId` 不参与授权和归属判断；
- 写事件前验证课程 assignment；新任务上线后改为验证 `task_learners`；
- admin/teacher 预览不污染正式学员统计；
- 旧 `student` URL 参数进入弃用流程；
- 补充伪造他人 ID、无 assignment、禁用学员、管理员预览等测试。

## 4. 下一步顺序

1. Gate 0.1 报告与探针修订：已完成；
2. Gate 0 复验：已通过；
3. Gate 0.5 身份可信修复：待实施；
4. Gate 0.5 通过后，下发 Gate 1 学习任务与权限闭环任务卡。
