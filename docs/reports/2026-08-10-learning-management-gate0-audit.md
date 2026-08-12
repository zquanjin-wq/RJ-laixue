# Laixue 学习管理与 AI 教学闭环 Gate 0 技术盘点

**日期：** 2026-08-10  
**任务卡：** P0 · 学习管理与 AI 教学闭环 Gate 0 技术盘点  
**仓库：** `RJ-laixue`  
**范围：** 只读技术盘点，不实现业务页面、不执行生产迁移、不擅自决策。

---

## 1. 任务与范围

本报告回应任务卡提出的 6 个核心未知项：

1. PC/移动端分别记录了哪些学习行为；
2. `runtime_sessions` / `runtime_records` 是否持久化 AI 提问/回复和检查题作答；
3. 检查题是否有稳定的题目 ID、答案、正确性和章节关联；
4. OpenMAIC 课程数据能否在任务发布时生成稳定课程结构快照；
5. 现有 `course_assignments` / `course_progress_events` 应扩展/迁移还是保留为兼容层；
6. 如何以最小侵入方式统一 PC/移动端进度和有效时长。

调查方法：代码静态分析 + SQL 结构分析 + 运行时代码走读。本报告中的证据按以下三类区分：

- **静态代码事实**：直接来自代码、迁移文件或类型定义，无需访问运行环境即可验证。
- **待运行验证**：需在实际 Supabase/运行环境中执行探针或查询才能获得脱敏结果；本盘点未操作生产数据，因此相关结论保留为"待验证"口径。
- **已有运行证据**：来自本地开发环境、测试套件或已公开的 CI 产物。

除非特别说明，本报告默认基于第一类（静态代码事实）。

---

## 2. 现有学习数据模型

### 2.1 `public.students`

- `id uuid primary key default gen_random_uuid()`
- `access_code text unique`
- `name text not null`, `email text`, `employee_no text`
- 唯一索引：`email`, `access_code`, `employee_no`

来源：`supabase-learning-mvp.sql:6-34`

### 2.2 `public.course_assignments`

- `id uuid primary key`
- `course_id text not null`
- `student_id uuid not null references public.students(id) on delete cascade`
- `status text not null default 'not_started' check (status in ('not_started', 'in_progress', 'completed'))`
- `assigned_at`, `started_at`, `completed_at`, `last_seen_at`, `due_at`
- 唯一约束：`(course_id, student_id)`

来源：`supabase-learning-mvp.sql:36-58`

### 2.3 `public.course_progress_events`

- `id uuid primary key`
- `course_id text not null`
- `student_id uuid references public.students(id) on delete set null`
- `assignment_id uuid references public.course_assignments(id) on delete set null`
- `event_type text not null check (event_type in ('open_course', 'view_scene', 'complete_course'))`
- `scene_id text`, `scene_order integer`
- `metadata jsonb not null default '{}'`

来源：`supabase-learning-mvp.sql:60-77`

### 2.4 `public.courses`

- `id text primary key`
- `title text`, `topic text`
- `data jsonb`：OpenMAIC 课程 DSL 内容
- `created_by text default ''`

来源：`supabase-courses-baseline.sql`

### 2.5 `runtime_sessions` / `runtime_records`

- `runtime_sessions.id text primary key`
- `runtime_sessions.kind text not null`：session 级语义标签，如 `chat`、`quizAttempt`、`playback`
- 业务键：`(stage_id, learner_key)`
- `runtime_records.id text`（外部 record id，全局唯一，幂等去重；`runtime_records_id_unique` 唯一索引）
- `runtime_records.payload jsonb not null`
- `runtime_records` **没有 `kind` 字段**；record 的语义由所属 session 的 `kind` 决定

来源：`supabase-runtime-store-v1.sql:38-76`

**重要：** 后续按 kind 查询 record 时必须关联父 session，例如：

```sql
select r.*
from runtime_records r
join runtime_sessions s on s.id = r.session_id
where s.kind = 'quizAttempt'
  and s.stage_id = :stage_id
  and s.learner_key = :learner_key;
```

不能写成 `runtime_records.kind = ...`。

---

## 3. 现有学习事件字典

当前事件类型被硬编码在数据库和业务代码两层：

```sql
-- supabase-learning-mvp.sql:65-66
event_type text not null
  check (event_type in ('open_course', 'view_scene', 'complete_course')),
```

服务端 API 同样只接受这三个值：

```ts
// app/api/learning/events/route.ts:17
if (!['open_course', 'view_scene', 'complete_course'].includes(eventType)) {
  return NextResponse.json(
    { success: false, error: '无效的学习事件类型' },
    { status: 400 },
  );
}
```

结论：事件字典尚未覆盖 AI 提问、检查题作答、播放心跳、暂停/恢复等 Gate 1 需要的语义。Codex 已裁决采用"业务学习事件 + RuntimeStore 细粒度记录"两层模型（见第 10 节），Gate 1 应在该模型下冻结扩展后的事件字典，避免在 JSON `metadata` 里无约束打补丁导致统计口径混乱。

---

## 4. PC 端学习行为记录现状

### 4.1 入口与参数

PC 端入口：`app/classroom/[id]/page.tsx`

支持的查询参数：
- `share=1`：只读分享模式
- `student=<uuid>`：服务端信任的学员 ID
- `editor=1` / `view=1`：编辑/预览模式
- `sceneId=<string>`：恢复位置

登录要求：Supabase Auth；未登录重定向 `/login?next=`。

### 4.2 学习事件发送条件

当前仅在 `readOnlyShare && verifiedStudentId` 为真时发送 `open_course` 和 `complete_course`：

```ts
// app/classroom/[id]/page.tsx:578-590
if (!readOnlyShare || !verifiedStudentId || openEventSentRef.current) return;
openEventSentRef.current = true;
recordLearningEvent({
  courseId: classroomId,
  studentId: verifiedStudentId!,
  eventType: 'open_course',
});

// app/classroom/[id]/page.tsx:604-613
const lastOrder = Math.max(...scenes.map((scene) => scene.order));
if (!currentScene || currentScene.order < lastOrder) return;
completeEventSentRef.current = true;
recordLearningEvent({
  courseId: classroomId,
  studentId: verifiedStudentId!,
  eventType: 'complete_course',
});
```

**注意：** `app/classroom/[id]/page.tsx` 中只有 `open_course` 和 `complete_course` 两个调用点，没有 `view_scene` 调用。`view_scene` 虽然被 `course_progress_events` 的事件字典和 `/api/learning/events` API 支持，但当前 PC 端 classroom 页面并未发送该事件。

### 4.3 完成判定问题

PC 端通过"到达最大 scene order"判定课程完成：

```ts
// app/classroom/[id]/page.tsx（节选）
const lastOrder = Math.max(...scenes.map((scene) => scene.order));
if (!currentScene || currentScene.order < lastOrder) return;
```

这与总计划 `docs/plans/learning-management-ai-phase1.md` 中的约束冲突：

> "到达最后一页不等于完成。"

风险：若最后一个 scene 是检查题或 PBL，学员只是翻到最后即被标记 `completed`，检查题未做也被视为完成。

### 4.4 当前 PC 端记录的学习行为

| 行为 | 是否记录 | 落点 | 备注 |
|---|---|---|---|
| 打开课程 | 是（仅 share=1） | `course_progress_events` | `event_type='open_course'` |
| 浏览场景 | 否 | — | `view_scene` 受 API/字典支持，但当前 classroom 页面未发送 |
| 到达末页 | 是（仅 share=1） | `course_progress_events` + 更新 `course_assignments.status='completed'` | 判定口径过宽 |
| AI 提问 | 否 | 仅在客户端内存/SSE 流中 | 未进入 `runtime_records` |
| 检查题作答 | 否 | `localStorage` + shadow-writer（开关开启时） | 生产环境开关未明确开启 |
| 播放/暂停 | 否 | 无 | 无有效时长计算 |

---

## 5. 移动端学习行为记录现状

### 5.1 入口与参数

移动端入口：`app/m/[id]/page.tsx`（RSC shell） + `app/m/[id]/_components/MobilePlayer.tsx`（客户端播放）。

支持的查询参数：
- `share=1` / `student=<uuid>` / `view=1`

登录要求：同样 Supabase Auth。

### 5.2 进度持久化方式

移动端进度完全依赖 `localStorage`：

```ts
// lib/mobile/progress.ts
const key = `mobile.progress.${courseId}`;
// 保存：sceneIndex, audioOffset, totalScenes, updatedAt
```

来源：`lib/mobile/progress.ts`

### 5.3 提问次数限制

移动端 AI 提问次数也使用 `localStorage`：

```ts
// lib/mobile/question-limit.ts
const key = `mobile.questions.${courseId}`;
// pilot 限制 5 次
```

来源：`lib/mobile/question-limit.ts`

### 5.4 AI 提问链路

移动端 AI 提问调用 `/api/chat`，在本地解析 SSE 回复后递增计数；未写入 `runtime_records` 或 `course_progress_events`。

来源：`app/m/[id]/_components/MobilePlayer.tsx`

### 5.5 切页完成

`markSceneComplete` 仅更新 `localStorage`，未调用任何服务端 API。

来源：`app/m/[id]/_components/MobilePlayer.tsx`

### 5.6 当前移动端记录的学习行为

| 行为 | 是否记录 | 落点 | 备注 |
|---|---|---|---|
| 打开课程 | 否 | 无 | 未发送 `open_course` |
| 浏览场景 | 否 | `localStorage` | 未发送 `view_scene` |
| 场景完成 | 否 | `localStorage` | 未发送 `complete_course` |
| AI 提问 | 否 | 本地计数 + `/api/chat` | 未持久化 |
| 检查题作答 | 否 | 本地未实现检查题 | 移动端 `buildChapters` 过滤 quiz/interactive/pbl |
| 有效时长 | 否 | 无 | 无 |

结论：移动端目前是一条完全独立的本地进度链路，与 PC 端云端进度不互通。

---

## 6. AI 提问与检查题作答持久化现状

### 6.1 `runtime_records` 当前 payload 结构

从 `lib/runtime/shadow-writer.ts` 看，R2 影子双写在开关开启时向 RuntimeStore 镜像三类数据：

#### chat

```ts
payload: { role, content }
```

仅记录角色和内容，不区分用户提问与 AI 回复；不记录场景上下文、不记录 token 消耗。

#### quizAttempt

```ts
// 提交阶段
payload: { phase: 'submitted' as const, answers: envelope.answers }
// 批改阶段
payload: { phase: 'reviewed' as const, answers: envelope.answers, results }
```

`results` 的结构来自 `lib/quiz/grading.ts`：

```ts
export interface QuestionResult {
  questionId: string;
  correct: boolean | null;
  status: 'correct' | 'incorrect';
  earned: number;
  aiComment?: string;
}
```

#### playback

```ts
payload: {
  v: 1,
  sceneId,
  sceneIndex,
  actionIndex,
  consumedDiscussions: row.consumedDiscussions ?? [],
  capturedAt,
}
```

### 6.2 当前是否持久化了 AI 提问/回复？

- PC 端：AI 提问/回复通过 `/api/chat` 走 OpenAI 兼容流，当前未进入 `runtime_records`。仅在 `NEXT_PUBLIC_RUNTIME_SHADOW=1` 等开关开启时，`shadow-writer` 会把 chat 镜像过去。
- 移动端：AI 提问在本地解析 SSE，未进入任何持久化存储。

结论：**AI 提问/回复在生产环境默认未持久化**，取决于影子开关，不是稳定事实源。

### 6.3 当前是否持久化了检查题作答？

- PC 端：检查题作答先写入 `localStorage`（`quizDraft:<sceneId>`、`quizAnswers:<sceneId>`、`quizResults:<sceneId>`），再经 shadow-writer/outbox 异步写入 `runtime_records`（仅在开关开启时）。
- 移动端：未实现检查题渲染；`lib/mobile/scene-helpers.ts` 过滤了 `quiz/interactive/pbl`。

结论：**检查题作答在生产环境默认也未持久化到服务端事实源**。

### 6.4 payload-validators 覆盖缺口

`lib/runtime/payload-validators.ts` 只注册了 `chat`（role+content）和 `quizAttempt`（phase+answers）。

缺失：
- AI 提问元数据（场景 ID、消息 ID、模型、token 消耗）
- 检查题标准答案、评分结果、attempt 链
- 学习事件心跳/暂停/恢复

---

## 7. 检查题结构稳定性

### 7.1 题目 ID

OpenMAIC DSL 中 `QuizQuestion.id` 是稳定字符串：

```ts
// packages/@openmaic/dsl/src/stage.ts
export interface QuizQuestion {
  id: string;
  type: 'single' | 'multiple' | 'short_answer';
  question: string;
  options?: QuizOption[];
  answer?: string[];
  analysis?: string;
  commentPrompt?: string;
  hasAnswer?: boolean;
  points?: number;
}
```

来源：`packages/@openmaic/dsl/src/stage.ts`

应用层重新导出：`lib/types/stage.ts`。

结论：检查题 ID 稳定，可用于跨端同步和成绩汇总。

### 7.2 答案与正确性

- 答案字段：`answer?: string[]`
- 正确性：非简答题通过 `gradeChoiceQuestions` 按 `q.answer` 精确匹配；简答题通过 `/api/quiz-grade` 由 AI 评分。
- 评分结果：`QuestionResult` 含 `questionId`、`correct`、`status`、`earned`、`aiComment`。

来源：`lib/quiz/grading.ts`

### 7.3 检查题答案泄漏风险（快照/探针输出）

`QuizQuestion.answer` 含标准答案。在只读探针和课程快照验证输出中，应避免直接输出 `answer` 数组；改为输出 `hasAnswer`、题型和 `points`。正式内部快照是否保存标准答案留给 Gate 1 安全设计决定。

### 7.4 章节关联

当前 DSL 没有独立的"章节"实体；章节感观由 `Scene` 的顺序和 `outlines`（若存在）提供。检查题以 `Scene` 为载体，因此题目与"章节"的关联只能间接通过 `sceneId` 推断。

缺失：
- 没有显式的 `chapter_id` 或 `outline_id` 把题目绑定到章节。
- `course_objectives` 等任务卡期望字段不存在于当前 DSL，需要降级处理。

---

## 8. 课程结构快照能力

### 8.1 可稳定提取的字段

基于 `public.courses.data`（OpenMAIC DSL）可提取。真实持久化结构为 `{ stage, scenes, outlines }`：

- 课程级：`id`（即 `courses.id`）、`title`、`topic`
- Stage 级：`data.stage.id`、`data.stage.name`、`data.stage.description` 等
- Scene 级：`data.scenes` 数组中每项的 `id`、`type`、`title`、`order`/`seq`、`content`
- Quiz 场景：`scene.content.questions` 数组，含 `id`、`type`、`hasAnswer`、`points`；标准答案 `answer` 不进入验证输出
- Outline 级：`data.outlines` 数组，通过 `scene.outlineId` 反向匹配到 scene

### 8.2 缺失/需降级的字段

| 任务卡期望字段 | 当前 DSL 状态 | 建议处理 |
|---|---|---|
| `course_objectives` | 不存在 | 从 `stage.description` 或 `scene.content` 中启发式提取，否则留空 |
| 显式 chapter_id | 不存在 | 用 `scene.id` + `order` 作为快照节点 ID；移动端过滤掉的类型标记为 `skipped_in_mobile` |
| 检查题章节关联 | 间接 | 快照中记录 `sceneId` 作为容器；`scene.outlineId` 可关联 outline |
| 课程版本/修订号 | 不存在 | 用 `courses` 行更新时间或内容 hash 作为隐式版本 |
| 检查题标准答案是否进入快照 | 待定 | Gate 1 安全设计决定；探针验证输出不泄漏 |

### 8.3 快照生成方式建议

在任务发布时，由服务端读取 `public.courses.data`（结构 `{ stage, scenes, outlines }`），生成一份不可变的 JSON 快照，至少包含：

```json
{
  "courseId": "string",
  "generatedAt": "ISO8601",
  "sourceHash": "sha256-of-data",
  "stage": { "id": "string", "name": "string", "description": "string" },
  "scenes": [
    {
      "id": "string",
      "type": "slide|quiz|interactive|pbl",
      "title": "string",
      "order": 0,
      "chapter": { "id": "sceneId or outlineId", "title": "..." },
      "quizzes": [{ "id": "string", "type": "...", "hasAnswer": true, "points": 1 }]
    }
  ],
  "outlines": [{ "id": "string", "title": "string", "order": 0 }]
}
```

Outline 到 scene 的关联优先通过 `scene.outlineId` 匹配；无 `outlineId` 时以 scene 自身作为章节节点。快照中不输出 `quiz.answer` 标准答案。

结论：**可以生成稳定快照**，但需要从 DSL 中推断部分字段，并明确记录推断规则。

---

## 9. 身份与权限风险

### 9.1 `studentId` 被服务端直接信任

`recordLearningEvent` 直接信任客户端传入的 `studentId`：

```ts
// lib/server/learning-mvp.ts:176-195
export async function recordLearningEvent(input: LearningEventInput) {
  const { courseId, studentId, eventType, sceneId, sceneOrder, metadata } = input;
  // ...
  if (studentId) {
    const { data, error } = await supabase
      .from('course_assignments')
      .select('id, status')
      .eq('course_id', courseId)
      .eq('student_id', studentId)
      .maybeSingle();
```

API 层原样透传：

```ts
// app/api/learning/events/route.ts:24-34
const data = await recordLearningEvent({
  courseId,
  studentId: typeof body.studentId === 'string' ? body.studentId : undefined,
  // ...
});
```

风险：
- 知道任意学员 UUID 即可伪造其学习事件。
- `share=1` 模式通过 `student=` URL 参数传入 UUID，URL 可被转发或猜测。
- 未从登录态解析学员身份。

### 9.2 RLS 已收紧但路径仍依赖 service_role

- Wave 1 撤销 anon 对学习表的写权限。
- Wave 5 撤销 anon 对学习表和 courses 的所有权限。

来源：`supabase-rls-tighten-wave1.sql`、`supabase-rls-tighten-wave5.sql`

当前服务端通过 `getServiceSupabase()` 绕过 RLS，这是正确做法，但前提是 API 层必须自己做好身份校验。目前 `/api/learning/events` 没有做。

### 9.3 老师能否看到不属于自己的学习数据

`lib/server/learning-mvp.ts` 中没有老师身份校验；`listCourseAssignments` 只按 `course_id` 查询，不校验调用者是否是该课程的老师。这一点需要在 Gate 1 设计老师看板时单独审计。

### 9.4 `/api/learning` 在中间件白名单

```ts
// middleware.ts:53-60
pathname.startsWith('/api/learning')
```

这意味着 `/api/learning/events` 绕过了 access-code 校验。虽然这是有意为之（让学员无需 access-code 即可上报事件），但也意味着该端点必须依赖自己的身份校验，而目前没有。

---

## 10. 推荐决策：扩展/迁移/保留兼容层

### 10.1 推荐方案：保留 `course_assignments` + `course_progress_events`，新增冻结层（已获裁决 D1-D4）

Codex 已正式裁决（`docs/reports/2026-08-10-learning-management-gate0-review.md`）：

- **D1**：事件字典有条件采纳，采用"业务学习事件 + RuntimeStore 细粒度记录"两层模型，避免把完整数据复制到两边形成双事实源。
- **D2**：完成课程采用显式按钮，并要求必学 scene 完成、必做检查题已提交且 review 结束；不要求全部答对，完成度与掌握度分离。
- **D3**：移动端必须在第一阶段接入服务端统一进度，否则统计闭环不成立。
- **D4**：立即安排 Gate 0.5 修复 `studentId` 信任问题，且必须早于学习任务开发。

理由：
- `course_assignments` 已经是老师分配课程、查看状态的入口，迁移成本高。
- `course_progress_events` 已有 PC 端 share 模式的事件数据，可作为历史兼容层。
- `runtime_records` 是更细粒度的运行时事实源，适合 AI 提问、检查题 attempt、播放心跳等，但不适宜直接替代"课程完成状态"这种汇总语义。

### 10.2 建议的 Gate 1 数据分层（两层模型）

**业务学习事件层**（用于任务统计，保存在 `course_progress_events` 或后续冻结的任务事件表中）：

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

**RuntimeStore 细粒度记录层**（按 session kind 分组，record 只保存引用 ID 和聚合所需最小字段）：

| 数据 | 主存储 | 兼容层/汇总 | 备注 |
|---|---|---|---|
| 学员-课程分配 | `course_assignments` | 保留 | 历史兼容 |
| 课程级粗粒度事件 | `course_progress_events` | 保留只读兼容 | 旧 `open_course/view_scene/complete_course` 不再作为新任务主口径 |
| AI 提问/回复 | `runtime_sessions` kind=`chat` + `runtime_records` | `course_progress_events` 发 `question_asked`，含引用 ID | 不复制完整聊天内容 |
| 检查题作答 | `runtime_sessions` kind=`quizAttempt` + `runtime_records` | `course_progress_events` 发 `check_submitted`/`check_reviewed`，含 attemptId/score | 按 session 关联 record |
| 播放进度/心跳 | `runtime_sessions` kind=`playback` + `runtime_records` | 汇总有效时长后写回 `course_assignments.effective_duration_ms` | 按 session 关联 record |
| 课程快照 | 新增 `course_snapshots`（只读，发布时生成） | 无 | 结构 `{ stage, scenes, outlines }` |

### 10.3 不推荐直接迁移到 RuntimeStore 的理由

- RuntimeStore 的 `payload` 是自由 JSONB，不适合直接作为老师看板聚合源，需要额外 ETL。
- `course_assignments` 和 `course_progress_events` 已被多个现有页面依赖（学员首页、老师看板等）。
- 最小侵入原则要求新能力新增表/字段，而非推倒重来。

---

## 11. PC/移动端统一进度与有效时长方案

### 11.1 目标

- 同一学员在不同设备上看到的是同一份课程进度。
- 有效时长只计算"真实学习"，过滤挂机和后台切换。
- 移动端离线时可本地缓存，恢复后补传。

### 11.2 核心设计

#### 服务端为事实源

- 学员每次进入课程，服务端根据 `course_assignments` + 最后一次 `view_scene` 事件 + `runtime_records.playback` 返回恢复位置。
- 本地 `localStorage` 仅作为弱网/离线缓存，上线后先拉服务端状态再合并。

#### 事件模型（最小扩展）

在现有 `open_course` / `view_scene` / `complete_course` 基础上新增：

| 事件 | 触发时机 | 关键字段 |
|---|---|---|
| `view_scene` | 进入场景 | `sceneId`, `sceneOrder` |
| `scene_progress` | 播放进度心跳（每 30s） | `sceneId`, `audioOffset`, `durationMs`, `eventId` |
| `pause` | 用户暂停/切后台 | `sceneId`, `audioOffset` |
| `resume` | 恢复播放 | `sceneId`, `audioOffset` |
| `quiz_submit` | 提交检查题 | `sceneId`, `attemptId` |
| `quiz_review` | 检查题批改完成 | `sceneId`, `attemptId`, `score` |
| `ai_ask` | 学员发起 AI 提问 | `sceneId`, `messageId` |
| `complete_course` | 明确完成动作 | `method: 'manual' | 'auto'` |

#### 有效时长口径

- 心跳间隔 30 秒；两次心跳之间若空闲（无交互、未播放）超过 2 分钟，自动触发 `pause`。
- 有效时长 = Σ(心跳间隔内播放且非空闲的时间)。
- 移动端切后台/熄屏必须触发 `pause`。

#### 去重与补传

- 每个学习事件带客户端生成的 `eventId`（UUID v4）。
- 服务端 `course_progress_events.metadata` 或 `runtime_records.id` 做幂等。
- 移动端 outbox 已有退避、死信、租赁、依赖链机制（`lib/runtime/outbox.ts`），可复用。

### 11.3 最小侵入实现路径

1. **Gate 0 已做**：已冻结"业务学习事件 + RuntimeStore 细粒度记录"两层模型（D1）。
2. **Gate 0.5（已裁决 D4）**：在 `lib/server/learning-mvp.ts` 中新增 `resolveStudentFromSession()`，要求 `/api/learning/events` 不再信任客户端 `studentId`；从 Supabase session 解析用户，再经 `students.user_id = auth.uid()` 解析 student；写事件前验证课程 assignment；admin/teacher 预览不污染正式学员统计；旧 `student` URL 参数进入弃用流程。
3. **Gate 1**：
   - PC 端移除"到达末页即完成"逻辑，改为显式"完成学习"按钮 + 必学 scene 完成、必做检查题已提交且 review 结束才允许标记完成（D2）。
   - 移动端接入统一服务端进度，保留 localStorage 仅作为弱网/离线缓存（D3）。
   - 新增 `course_snapshots` 表和发布时快照生成，快照结构按 `{ stage, scenes, outlines }` 读取。
4. **Gate 2**：有效时长汇总和老师看板。

---

## 12. 只读探针脚本

已创建 `scripts/gate0-audit/` 目录，内置两个只读探针：

### 12.1 `scripts/gate0-audit/inspect-learning-schema.sql`

用途：在 Supabase SQL Editor 中执行，验证学习表结构、RLS 策略、索引是否与盘点一致。

关键查询：
- `course_progress_events` 的 event_type 约束
- `pg_policies` 中 anon 剩余权限
- `course_assignments` 的索引与唯一约束
- 近 30 天事件分布（若在生产执行，可获得脱敏运行证据）

**状态：** 本盘点未操作生产数据，因此关于"生产实际事件分布、生产实际 RLS"的结论属于"待运行验证"。SQL 探针保留，在 Gate 0.5/Gate 1 前置部署核验时执行。

### 12.2 `scripts/gate0-audit/inspect-course-snapshot.ts`

用途：本地 Node/Bun 脚本，读取 `public.courses.data` JSONB，按真实结构 `{ stage, scenes, outlines }` 输出标准化课程快照，验证可提取字段。

运行方式（需 `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`）：

```bash
cd "D:/WorkBuddy 地界/RJ-laixue"
npx tsx scripts/gate0-audit/inspect-course-snapshot.ts --courseId <course-id>
```

脚本只读，不写入任何数据；快照验证输出不泄漏检查题标准答案。

单元测试：`tests/lib/utils/course-snapshot.test.ts` 覆盖正常结构、空 scenes、quiz scene、order/seq 降级。

---

## 13. 风险清单与 Gate 0 验收标准

### 13.1 风险清单

| 编号 | 风险 | 严重度 | 当前状态 | 建议处理 |
|---|---|---|---|---|
| R1 | PC 端"到达末页即完成"导致完成口径错误 | 高 | 已确认（静态代码事实） | Gate 1 改为显式完成 + 必学/必做前置条件（D2） |
| R2 | 服务端信任客户端 `studentId`，可伪造学习事件 | 高 | 已确认（静态代码事实） | Gate 0.5 从 session 解析身份（D4） |
| R3 | 移动端进度完全在 localStorage，与 PC 端不同步 | 高 | 已确认（静态代码事实） | Gate 1 接入统一服务端进度（D3） |
| R4 | AI 提问/回复默认未持久化 | 中 | 已确认（静态代码事实） | Gate 1 明确写入 runtime_sessions kind=`chat` |
| R5 | 检查题作答默认未持久化到事实源 | 中 | 已确认（静态代码事实） | Gate 1 明确写入 runtime_sessions kind=`quizAttempt` |
| R6 | 老师看板未做数据权限隔离 | 中 | 已确认（静态代码事实） | Gate 1 设计时增加老师-课程校验 |
| R7 | 事件字典过窄，无法覆盖 AI/检查题/心跳 | 中 | 已确认（静态代码事实） | Gate 0 已冻结两层事件模型（D1） |
| R8 | 课程快照缺少 `course_objectives` 等字段 | 低 | 已确认（静态代码事实） | Gate 0 已记录降级规则 |
| R9 | 生产 RLS/事件分布尚未实际验证 | 低 | 待运行验证 | Gate 0.5/Gate 1 前置部署核验 |

### 13.2 Gate 0 验收标准

- [x] 已明确 PC/移动端分别记录了哪些学习行为。
- [x] 已明确 `runtime_sessions` / `runtime_records` 当前不默认持久化 AI 提问/回复和检查题作答，仅在 shadow 开关开启时镜像。
- [x] 已确认检查题有稳定 ID、答案和评分结果，但章节关联只能通过 scene 间接推断。
- [x] 已确认 OpenMAIC 课程数据可生成稳定快照，部分字段需要降级。
- [x] 已给出 `course_assignments` / `course_progress_events` 保留并作为兼容层、新增 `course_snapshots` 和 RuntimeStore 细粒度记录的推荐方案。
- [x] 已给出 PC/移动端统一进度和有效时长的最小侵入路径。
- [x] 已同步 Codex 裁决 D1-D4。
- [ ] **待 Codex 复验 Gate 0.1 修订后通过**。
- [ ] **待 Gate 0.5 任务卡下发并修复 R2 `studentId` 信任问题**。

---

## 14. 附录：关键代码引用

### 14.1 数据库约束

- `supabase-learning-mvp.sql:60-77`：`course_progress_events` 结构
- `supabase-learning-mvp.sql:79-94`：初始 anon RLS（已被 wave1/wave5 撤销）
- `supabase-rls-tighten-wave1.sql:23-35`：撤销 anon 写权限
- `supabase-rls-tighten-wave5.sql:18-30`：撤销 anon 所有权限

### 14.2 服务端学习事件

- `lib/server/learning-mvp.ts:176-235`：`recordLearningEvent`
- `app/api/learning/events/route.ts:1-43`：API 入口

### 14.3 PC 端入口与完成判定

- `app/classroom/[id]/page.tsx`：入口、参数解析、事件触发、完成判定

### 14.4 移动端进度

- `lib/mobile/progress.ts`：localStorage 进度
- `lib/mobile/question-limit.ts`：localStorage 提问限制
- `app/m/[id]/_components/MobilePlayer.tsx`：播放与 AI 提问
- `lib/mobile/scene-helpers.ts`：过滤 quiz/interactive/pbl

### 14.5 RuntimeStore 与校验器

- `lib/runtime/shadow-writer.ts`：chat/quizAttempt/playback payload
- `lib/runtime/payload-validators.ts`：当前校验器
- `lib/runtime/outbox.ts`：通用 outbox 机制
- `lib/runtime/quiz-outbox.ts`：quiz attempt 依赖链

### 14.6 检查题评分与持久化

- `packages/@openmaic/dsl/src/stage.ts`：`QuizQuestion` DSL
- `lib/quiz/grading.ts`：`gradeChoiceQuestions`、`QuestionResult`
- `lib/quiz/persistence.ts`：localStorage 三键持久化
- `components/scene-renderers/quiz-view.tsx`：PC 端检查题渲染与提交

### 14.7 中间件

- `middleware.ts:53-60`：`/api/learning` 白名单

---

*报告结束。本盘点基于代码静态分析，未操作生产数据。*
