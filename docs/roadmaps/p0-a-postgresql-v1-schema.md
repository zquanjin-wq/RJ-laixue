# P0-A：大陆版 PostgreSQL v1 Schema 设计

> 状态：设计完成，待 P0 认证/COS 原型验证  
> 日期：2026-09-01  
> 性质：逻辑设计；P1 再生成和评审正式 migration SQL

## 1. 设计原则

1. 全新空库，不兼容或导入 Supabase 旧数据。
2. Better Auth 管理认证表和密码，业务表不接触密码数据。
3. 一个人只有一个用户 ID；admin/teacher 同样可以参加学习。
4. 课程正文继续使用 JSONB，避免重写 OpenMAIC 文档模型。
5. 学习事件是事实源，进度表是可重算的查询模型。
6. 课程发布快照不可变；任务发布后名单和课程包冻结。
7. 数据库约束保障底线，应用事务承载业务流程。
8. 所有时间使用 `timestamptz`，服务端和数据库统一 UTC。
9. 正式数据不依赖容器本机文件系统。

## 2. Schema 分区

P0-B 验证后建议使用以下布局：

```text
public    Better Auth 默认生成和管理的 4 张表
app       laixue 业务表
runtime   OpenMAIC RuntimeStore
```

保持 Better Auth 默认布局可以减少额外连接配置。应用数据库只从服务端使用，不为浏览器提供 anon/authenticated 数据库角色。

## 3. 认证与人员

### 3.1 Better Auth 管理表

由 Better Auth 确定性生成 SQL，预计包含：

```text
auth.user
auth.session
auth.account
auth.verification
```

P0-B 实测 Better Auth 1.7.2 在普通 PostgreSQL 中创建 `user`、`session`、`account`、`verification` 四张表，用户 ID 为 text。正式 migration 在 P1 生成并纳入仓库，生产启动过程不自动改表。

### 3.2 `app.user_profiles`

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `user_id` | text | PK；关联 Better Auth user ID |
| `role` | text | `admin / teacher / learner` |
| `display_name` | text | 非空 |
| `employee_no` | text | 可空；非空时大小写不敏感唯一 |
| `department` | text | 可空 |
| `must_change_password` | boolean | 管理员发临时密码后为 true |
| `created_at` | timestamptz | 非空 |
| `updated_at` | timestamptz | 非空 |

规则：

- 邮箱由 Better Auth user 保存并唯一约束。
- 禁用账号由 Better Auth 管理，不删除业务档案，也不级联删除课程和学习事实。
- teacher/admin 无需生成另一条 learner/student 记录；任务分配直接引用 `user_id`。
- `role` 首期单值即可；不引入通用多角色表。

## 4. 课程与资产

### 4.1 `app.courses`

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `id` | text | PK；保留客户端/OpenMAIC 现有 ID，避免全面 UUID 改造 |
| `owner_user_id` | user id | 非空；不可由普通更新改变 |
| `title` | text | 非空 |
| `topic` | text | 可空 |
| `content` | jsonb | 非空；包含 stage/scenes/outlines |
| `save_state` | text | `draft / ready / failed` |
| `content_revision` | bigint | 非空，从 1 开始；乐观并发版本 |
| `created_at` | timestamptz | 非空 |
| `updated_at` | timestamptz | 非空 |
| `deleted_at` | timestamptz | 可空；首期软删除 |

索引：所有者课程列表、更新时间、未删除课程。

### 4.2 `app.course_assets`

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `id` | uuid | PK |
| `course_id` | text | 可空；pending 上传在绑定课程前为空 |
| `owner_user_id` | user id | 非空 |
| `kind` | text | `audio / image / material / video / pbl / other` |
| `object_key` | text | 唯一；COS key |
| `content_type` | text | 非空 |
| `size_bytes` | bigint | 非负 |
| `state` | text | `pending / ready / deleting / deleted / failed` |
| `created_at` | timestamptz | 非空 |
| `bound_at` | timestamptz | 可空 |
| `deleted_at` | timestamptz | 可空 |

规则：

- 数据库保存 object key，不保存预签名 URL。
- pending 对象必须有限期清理。
- 课程删除只把资产标为 deleting，由后台任务清理 COS 后标记 deleted。

### 4.3 `app.course_snapshots`

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `id` | uuid | PK |
| `course_id` | text | 非空 FK |
| `course_revision` | bigint | 非空 |
| `content` | jsonb | 非空且不可更新 |
| `created_by` | user id | 非空 |
| `created_at` | timestamptz | 非空 |

唯一约束：`(course_id, course_revision)`。禁止 UPDATE；被已发布任务引用时禁止 DELETE。

## 5. 学习任务

### 5.1 `app.learning_tasks`

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `id` | uuid | PK |
| `title` | text | 非空 |
| `description` | text | 可空 |
| `created_by` | user id | 非空 |
| `status` | text | `draft / published / closed / archived` |
| `task_type` | text | `normal / remedial` |
| `source_task_id` | uuid | remedial 必填，normal 必空 |
| `start_at` | timestamptz | 可空 |
| `due_at` | timestamptz | 不早于 start_at |
| `completion_rule` | jsonb | 带 version 的规则对象 |
| `share_token` | text | 可空且唯一；发布时生成 |
| `published_at` | timestamptz | published 时非空 |
| `created_at` | timestamptz | 非空 |
| `updated_at` | timestamptz | 非空 |

删除旧 `course_id`/`snapshot_id` 单课程兼容字段，课程包由 `task_courses` 唯一表达。

### 5.2 `app.task_courses`

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `task_id` | uuid | 联合 PK/FK |
| `course_id` | text | 联合 PK/FK |
| `position` | integer | 每任务唯一且大于 0 |
| `is_required` | boolean | 非空 |
| `snapshot_id` | uuid | 发布后非空 |
| `created_at` | timestamptz | 非空 |

任务发布后禁止增删改。

### 5.3 `app.task_assignments`

替代旧 `task_learners` 和早期 `course_assignments`。

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `id` | uuid | PK |
| `task_id` | uuid | 非空 FK |
| `user_id` | user id | 非空；任何角色都可成为学习者 |
| `status` | text | `not_started / in_progress / completed` |
| `progress_percent` | numeric(5,2) | 0～100 |
| `mastery_percent` | numeric(5,2) | 可空，0～100 |
| `effective_seconds` | bigint | 非负 |
| `completed_scene_count` | integer | 非负 |
| `total_scene_count` | integer | 非负且不小于 completed |
| `started_at` | timestamptz | 可空 |
| `completion_requested_at` | timestamptz | 可空 |
| `completed_at` | timestamptz | 可空 |
| `last_seen_at` | timestamptz | 可空 |
| `last_scene_id` | text | 可空 |
| `assigned_at` | timestamptz | 非空 |
| `updated_at` | timestamptz | 非空 |

唯一约束：`(task_id, user_id)`。任务发布后默认冻结名单。

### 5.4 `app.task_course_progress`

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `task_id` | uuid | 联合 PK |
| `user_id` | user id | 联合 PK |
| `course_id` | text | 联合 PK |
| `status` | text | 三态 |
| `progress_percent` | numeric(5,2) | 0～100 |
| `effective_seconds` | bigint | 非负 |
| `started_at` | timestamptz | 可空 |
| `completed_at` | timestamptz | 可空 |
| `last_seen_at` | timestamptz | 可空 |
| `updated_at` | timestamptz | 非空 |

该表为查询模型，可由学习事件重算；发布任务时按 assignment × task course 原子初始化。

## 6. 学习事实

### 6.1 `app.learning_attempts`

当前旧库没有独立 attempt，v1 新增以正确承载多次进入和有效时长窗口。

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `id` | uuid | PK |
| `task_id` | uuid | 非空 |
| `user_id` | user id | 非空 |
| `course_id` | text | 可空；任务级进入时可为空 |
| `session_key` | text | 非空，客户端一次学习会话标识 |
| `status` | text | `active / completed / abandoned` |
| `started_at` | timestamptz | 非空 |
| `last_activity_at` | timestamptz | 非空 |
| `ended_at` | timestamptz | 可空 |
| `effective_seconds` | bigint | 非负 |
| `created_at` | timestamptz | 非空 |
| `updated_at` | timestamptz | 非空 |

唯一约束：`(task_id, user_id, session_key)`。

### 6.2 `app.learning_events`

替代 `task_learning_events` 和早期 `course_progress_events`。

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `id` | uuid | PK |
| `attempt_id` | uuid | 非空 FK |
| `task_id` | uuid | 非空，冗余用于高频查询 |
| `user_id` | user id | 非空，由服务端 session 推导 |
| `course_id` | text | 可空 |
| `client_event_id` | text | 非空，幂等键 |
| `event_type` | text | 受控事件词表 |
| `scene_id` | text | 可空 |
| `scene_order` | integer | 可空 |
| `payload` | jsonb | 非空，限制最大体积 |
| `occurred_at` | timestamptz | 客户端发生时间，容忍窗口内使用 |
| `received_at` | timestamptz | 服务端时间，非空 |

唯一约束：`(task_id, user_id, client_event_id)`。

服务端聚合时以 `received_at` 和活动窗口为可信边界，不能直接累加客户端声明时长。

## 7. AI 教学分析

### 7.1 `app.ai_learning_summaries`

保留旧设计：task、scope（class/user）、可空 user_id、content、model、prompt_version、data_version、created_at。增加创建者和失败/过期标识可在 P4 决定。

### 7.2 `app.ai_intervention_suggestions`

保留 suggestion 主表，但不再使用 `learner_ids uuid[]`：

```text
ai_intervention_suggestions
ai_intervention_targets(suggestion_id, user_id)
```

这样可以建立外键、避免数组悬空，并高效查询某学员的建议。

## 8. RuntimeStore

保留现有三张表的核心结构和契约：

```text
runtime.runtime_sessions
runtime.runtime_records
runtime.runtime_merge_grants
```

必须保留：

- session `revision` CAS。
- 每 session 单调 `next_seq`。
- record ID 全局唯一和幂等回显比对。
- learner_key 允许匿名临时 key，不强制 UUID。
- 匿名 learner 合并 grant 一次性核销。
- create/merge 的 learner 级并发协调。
- DSL 版本迁移与未来版本拒绝。

可以删除：`auth.uid()` RLS、service_role grant 和 PostgREST 专属包装。最终选择数据库函数还是 node-postgres 事务，由 P1 并发契约测试结果决定。

## 9. 后台任务与用量

### 9.1 `app.background_jobs`

统一承载课堂生成、重新配音、资产清理和未来异步任务：

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `id` | text/uuid | PK |
| `type` | text | 任务类型 |
| `owner_user_id` | user id | 非空 |
| `resource_type` | text | 可空 |
| `resource_id` | text | 可空 |
| `status` | text | `queued/running/succeeded/failed/cancelled/conflict` |
| `payload` | jsonb | 非空；敏感信息不得落库 |
| `progress` | jsonb | 非空默认 `{}` |
| `result` | jsonb | 可空 |
| `error_code` | text | 可空 |
| `error_message` | text | 可空且长度受限 |
| `attempts` | integer | 非负 |
| `max_attempts` | integer | 正数 |
| `run_after` | timestamptz | 非空 |
| `locked_by` | text | 可空 |
| `locked_until` | timestamptz | 可空 |
| `source_revision` | bigint/text | 可空；提交时乐观检查 |
| `created_at/started_at/completed_at/updated_at` | timestamptz | 状态时间 |

对重新配音增加部分唯一索引，保证同一课程最多一个 queued/running 任务。

### 9.2 `app.usage_events`

替代月度 JSONL，字段保留 kind、source、provider、model、token 分类、quantity、unit、created_at，并增加 `user_id`、`request_id` 和幂等唯一约束。写入失败仍不得阻断生成主流程。

## 10. 核心事务

### 创建任务

1. 校验创建者角色与课程所有权。
2. 校验所有 user ID 存在且 active，去重后数量必须与输入一致。
3. 插入 task、task_courses、task_assignments。
4. 任一失败整体回滚。

### 发布任务

1. `SELECT task FOR UPDATE`。
2. 校验创建者/管理员、draft、非空课程包和非空名单。
3. 为每门课程按当前 revision 生成或复用不可变 snapshot。
4. 写入 task_courses.snapshot_id。
5. 初始化 assignment × course 进度行。
6. 生成不重复的分享 token 并保存。
7. 更新 published 状态并提交；重复请求返回同一已发布结果。

### 记录学习事件

1. 从 session 取 user ID，不读取客户端 user ID。
2. 校验已发布任务和 assignment。
3. 按 client_event_id 幂等插入。
4. 在同一事务中更新 attempt、task_course_progress、task_assignment 聚合。
5. heartbeat 只按服务端允许的最大活动窗口累计。

### 后台任务抢占与提交

1. 通过 `FOR UPDATE SKIP LOCKED` 或等价原子更新取得到期任务和租约。
2. worker 定期续租；进程退出后租约到期可重试。
3. 提交重新配音结果前检查 course revision。
4. 版本冲突标记 conflict，不覆盖教师的新编辑。

## 11. 删除策略

| 实体 | 策略 |
|---|---|
| 用户 | 禁用，不物理删除；保留历史归属和学习事实 |
| 课程 | 首期软删除；被 snapshot/task 引用时不可物理删除 |
| 资产 | 标记 deleting，后台清 COS 后标 deleted |
| 草稿任务 | 可删除并级联草稿明细 |
| 已发布任务 | 关闭/归档，不物理删除 |
| 学习事件 | 不由普通业务接口修改或删除 |
| 课程快照 | 不可更新；被任务引用时不可删除 |

## 12. P1 migration 拆分建议

```text
0001_extensions_and_schemas.sql
0002_auth_generated.sql
0003_user_profiles.sql
0004_courses_and_assets.sql
0005_learning_tasks.sql
0006_learning_facts.sql
0007_runtime_store.sql
0008_background_jobs_and_usage.sql
0009_constraints_and_indexes.sql
```

每个 migration 只向前执行并记录 checksum。禁止把旧 `supabase-*.sql` 直接拼接为新库初始化脚本。

## 13. P1 前待确认

- [x] Better Auth user ID 为 text；认证表使用默认 public schema。
- [ ] 明确采用“显式任务分配”，而不是所有 active 学员自动看全部课程。
- [ ] 是否保留旧 access code 分享；建议首期不保留，统一账号登录。
- [ ] COS 原型确认单桶前缀方案、预签名和 Range 播放。
- [ ] 课程生成临时结果是直接写 courses，还是先写 background job result 再确认入库。
- [ ] `usage_events` 首期是否必须进入数据库；建议进入，便于成本分析和备份。
