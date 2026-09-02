# P0-A：Supabase 耦合审计

> 状态：完成  
> 日期：2026-09-01  
> 范围：源码、`supabase-*.sql`、部署配置及核心产品文档  
> 限制：未连接生产 Supabase，结论以仓库中的代码和历史 SQL 为准

## 1. 结论

当前 Supabase 同时承担六类职责，不能通过替换环境变量移除：

1. 浏览器和服务端认证、Cookie session、管理员用户生命周期。
2. 业务数据库及 JSONB 课程文档。
3. PostgREST 查询客户端。
4. RPC 事务、并发控制和幂等操作。
5. Storage 直传、服务端上传、公开 URL 和材料下载。
6. RLS 行权限和 `service_role` 特权访问。

宽口径扫描发现 69 个生产代码文件具有 Supabase 语义依赖；其中 65 个直接引用 Supabase 客户端、认证方法或服务端 helper。重构必须先建立认证、数据访问、对象存储和授权边界，再按业务垂直切片替换。

由于旧数据无需保留，新系统可以删除 Supabase 兼容结构，不需要复刻 `auth.users`、PostgREST、RLS 角色或历史触发器。

## 2. 耦合分类

### 2.1 认证与账号生命周期

当前能力：

- 浏览器邮箱密码登录、登出、session 刷新和认证状态监听。
- RSC/API 通过 Cookie 获取当前用户。
- 管理员创建、删除、查询和更新 Auth 用户。
- 管理员设置初始密码、重置密码、启用和禁用账号。
- `auth.users` 插入后触发创建 `profiles`。
- 固定邮箱触发升级为首位管理员。
- `profiles` 与 `students` 之间通过触发器同步教师/管理员的学习身份。

涉及的 Supabase Auth 方法：

```text
getUser / getSession / refreshSession / onAuthStateChange
signInWithPassword / signOut
admin.createUser / deleteUser / getUserById / listUsers / updateUserById
```

替代边界：

- Better Auth 候选实现认证用户、密码、session 和基础账号生命周期。
- `app.user_profiles` 保存角色、工号、显示名称和首次改密要求；禁用状态由 Better Auth 管理。
- 服务端统一提供 `getCurrentUser`、`requireUser`、`requireRole`。
- 首位管理员通过一次性初始化命令创建，不再硬编码邮箱触发器。
- 禁用账号必须同时撤销全部 session。

### 2.2 业务数据与 PostgREST

代码实际访问的业务表：

```text
profiles
students
courses
course_assignments
course_progress_events
course_snapshots
learning_tasks
task_learners
task_courses
task_course_progress
task_learning_events
ai_learning_summaries
ai_intervention_suggestions
course_revoice_jobs
runtime_sessions
runtime_records
runtime_merge_grants
```

替代边界：

- 使用共享 `pg.Pool` 和版本化 SQL migrations。
- API、RSC 和后台任务通过 repository/service 层访问，禁止页面散落 SQL。
- 保留 JSONB 课程文档，首期不拆分 stage/scenes/outlines，以避免重写 OpenMAIC 核心。
- 数据库连接仅服务端可用，不向浏览器开放数据库接口。

### 2.3 RPC 与数据库事务

显式 RPC：

```text
claim_course_revoice_job
commit_course_revoice_job
count_task_learners
create_task_with_learners
publish_task_course_package
replace_task_courses
runtime_merge_with_grant
runtime_* 动态函数集
```

需要保留的不是 RPC 形式，而是以下语义：

- 创建任务与分配学员必须原子完成。
- 草稿任务才能修改课程包和学员名单。
- 发布任务时锁定任务、校验所有权和名单、生成不可变课程快照、生成 token、初始化逐课程进度，整体原子提交。
- 发布操作支持安全重放。
- 同一课程同一时间最多一个活跃重新配音任务。
- 重新配音通过租约抢占；仅当课程版本未变化时提交结果。
- RuntimeStore 保留 revision CAS、全局事件幂等键、顺序分配和匿名身份合并的并发语义。

替代方式：普通 PostgreSQL transaction + `SELECT ... FOR UPDATE` + 唯一/检查约束；RuntimeStore 可继续保留数据库函数，也可以经 node-postgres 执行事务，但必须通过现有真实 PostgreSQL 并发测试。

### 2.4 RLS 与应用授权

当前 RLS/`service_role` 模型：

- 浏览器认证身份由 Supabase 注入 `auth.uid()`。
- 部分表允许认证用户读取自己的行。
- 写入和管理操作普遍由服务端 `service_role` 绕过 RLS。
- 历史 SQL 曾允许 anon 访问，后续 tightening waves 再逐步收紧。

新系统不复刻 Supabase 数据库角色体系。授权全部进入服务端：

| 资源 | 读取 | 写入 |
|---|---|---|
| 用户档案 | 本人；管理员；教师按任务查看必要学员信息 | 管理员；本人仅改允许字段 |
| 课程 | 所有者、管理员；学员通过已发布任务 | 所有者或管理员 |
| 学习任务 | 创建者、管理员、被分配用户 | 创建者或管理员；发布后限制修改 |
| 学习事件 | 本人写自己的事件；任务所有者和管理员读 | 仅服务端按当前 session 写 |
| 课程资产 | 权限继承课程/任务 | 课程所有者或管理员 |
| 后台任务 | 请求者、课程所有者、管理员 | 服务端 worker |

API 层保留少量关键权限测试，覆盖课程归属、学员任务归属和管理员边界即可。

### 2.5 Supabase Storage

当前 bucket：

| Bucket | 当前用途 | 当前访问形态 |
|---|---|---|
| `course-audio` | 课堂/课程音频 | 服务端上传，公开 URL |
| `course-assets` | 音频、图片、材料、解析产物、重新配音结果 | 浏览器签名直传、服务端上传/下载、公开 URL |

对象路径还包含：

```text
courses/{courseId}/...
pbl/{projectId}/...
pending/{userId}/...
courses/{courseId}/audio/revoice/{jobId}/...
```

新系统使用 COS 私有桶和 Storage Adapter。必须保留：路径归属校验、大小/MIME 白名单、预签名短期上传、预签名读取、音频 Range 请求、临时对象清理和失败上传幂等。

建议不再区分两个业务 bucket；首期可以使用一个私有业务资产桶，通过固定前缀分类。数据库只保存 `object_key`，不保存会过期的签名 URL。

### 2.6 本机文件与隐性持久化

不属于 Supabase，但会影响大陆版重构：

| 路径/功能 | 当前存储 | 新归宿 |
|---|---|---|
| `data/classrooms/*.json` | 本机文件 | 正式课程进入 `courses.content`；临时生成结果进入任务结果或 COS |
| `data/classroom-jobs/*.json` | 本机文件 | `background_jobs` |
| `data/classroom-media/*` | 本机文件 | COS |
| `data/usage/*.jsonl` | 本机文件 | `usage_events`；失败可降级日志 |

Docker volume 可以暂时承载缓存和可重建临时文件，但不能成为课程、学习记录或任务状态的唯一正式存储。

## 3. 环境变量替换

必须删除的生产变量：

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_ACCESS_TOKEN
SUPABASE_DB_PASSWORD
SUPABASE_PROJECT_REF
```

新变量族建议：

```text
DATABASE_URL
BETTER_AUTH_SECRET
BETTER_AUTH_URL
COS_REGION
COS_BUCKET
COS_ENDPOINT（如 SDK 需要）
COS_SECRET_ID
COS_SECRET_KEY
BACKGROUND_WORKER_TOKEN
```

具体变量名在 P0 Better Auth/COS 原型通过后冻结。任何长期凭据均不得使用 `NEXT_PUBLIC_` 前缀。

## 4. 可以删除的历史兼容

- `profiles.id -> auth.users.id` 外键和 `handle_new_user` 触发器。
- 固定管理员邮箱的 `upgrade_seed_admin` 触发器。
- `students.user_id` 映射和 `sync_staff_learning_identity` 触发器。
- anon/authenticated/service_role 数据库角色与所有 RLS policy。
- Supabase Storage bucket 自动创建和公开 URL 逻辑。
- `course_assignments`、`course_progress_events` 旧学习 MVP 双轨表。
- `learning_tasks.course_id` 兼容字段；新系统以 `task_courses` 为唯一课程包来源。
- 为旧数据清洗、回填和宽化字段编写的 SQL 补丁。

历史 SQL 文件继续留在仓库作为旧系统资料，不参与新环境初始化。

## 5. 必须保留的业务规则

- 三种角色：admin、teacher、learner；教师和管理员也允许被分配学习任务。
- 无公众自助注册，账号由管理员创建。
- 账号禁用为软状态，历史学习数据不能级联删除。
- 课程所有权不可被普通保存请求篡改。
- 课程发布使用不可变快照，避免教师后续编辑改变已发布任务内容。
- 发布后的任务名单和课程包默认冻结。
- 学习事件由服务端从 session 推导 user ID，不接受客户端声明身份。
- 事件有客户端幂等 ID，重复上报不得重复计数。
- 课程和任务的进度、时长与完成状态有聚合快照，但事件流水保留事实来源。
- 后台任务使用租约、重试和乐观并发检查。
- RuntimeStore 的并发契约和版本守护必须保留。

## 6. 发现的产品口径冲突

旧 `docs/PRD.md` 写“所有 active 学员看所有云端课件”，较新的学习任务系统已经实现显式学员名单、课程包和任务发布。

P0-A 建议以较新的任务模型为准：

- 草稿课程只对所有者和管理员可见。
- 已发布课程不自动对所有员工开放。
- 学员通过明确的已发布学习任务获得访问权。
- 若以后需要“全员必修”，在任务上增加受众规则并展开为任务分配，不通过放开全部课程读取实现。

该结论应在 P1 开工前由产品负责人确认。

## 7. 迁移批次映射

| 垂直切片 | 主要替换对象 |
|---|---|
| P2 认证人员 | Auth、profiles、students、账号管理 API、页面路由保护 |
| P3 课程资产 | courses、course snapshots、两个 Storage bucket、课程权限 |
| P4 学习任务 | learning tasks、task learners/courses/progress/events、AI 报告 |
| P5 后台与运维 | revoice jobs、classroom jobs、usage JSONL、本机媒体 |
| Runtime 专项 | runtime tables/RPC、匿名合并 grant、并发测试 |

## 8. P0-A 完成判定

- [x] 认证、业务表、RPC、Storage、RLS、环境变量完成分类。
- [x] 本机文件持久化纳入范围。
- [x] 明确可删除的历史兼容和必须保留的业务规则。
- [x] 新版 Schema 所需实体与并发边界明确。
- [x] 未修改生产环境或现有运行代码。
