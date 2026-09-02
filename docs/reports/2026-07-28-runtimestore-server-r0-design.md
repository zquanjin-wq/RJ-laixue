# R0 设计文档：RuntimeStore 服务端化 + DocumentStore 服务端化（合并设计）

> 日期：2026-07-28
> 状态：**已拍板**（2026-07-28 晚，负责人逐条同意）：
> ① mergeLearner 必须携带 access-code 绑定流程签发的短期 merge token，
>    客户端自报 fromLearnerKey 一律 403（第 5 节）——**同意**；
> ② 留存策略：archived 会话保留 24 个月后导出对象存储再物理清理（第 7 节）——**同意**；
> ③ RLS 不开教师口子，教师聚合走 API 层授权（第 1.3 节）——**同意**。
> 另：脏数据课程 `1I_kD25GX1` 已被负责人直接删除，拍板①的数据修复不再需要，
> 生成链路误分类 bug 立案（`2026-07-28-agent-text-action-leak.md`）仍有效。
> 下一步：R1 服务端 adapter（契约测试对服务端实现全绿为验收）。
> 依据：`docs/reports/2026-07-28-runtimestore-server-first-roadmap.md`（`9b9d768c`，已拍板）
> 范围：schema + RLS + seq/CAS + 幂等键 + 契约版本化 + 容量/留存 + 弱网 outbox +
> mergeLearner 服务端实现 + DocumentStore 服务端化合并设计 + 私有化可替换推论。
> 本文档逐条回应路线图第 6 节的 5 条开放问题，不重新讨论方向。

---

## 0. 设计基线（已核实的一手事实）

1. **RuntimeStore 契约**以 `packages/@openmaic/storage/src/runtime/types.ts` +
   `runtime/browser.ts` 为准（本 fork 已冷安装，B1 ✅）。browser 后端语义是服务端
   实现的**行为规格**：写入盖 `runtimeDslVersion` 戳、读取迁移、未来版本写保护、
   seq 事务内分配、append 仅允许 active 会话、payload 按父会话 kind 过 validator、
   delete 幂等且级联、mergeLearner 原子且自合并返回 0。服务端实现必须逐条等价，
   R1 用上游 `runtime-contract.ts` 测试套件对服务端后端跑全量验证。
2. **本 fork 无上游 HTTP 后端**（storage 包 src 下只有 browser 后端，无 `pg.ts`），
   且办公区 GFW 阻断 GitHub 直连，上游 v0.3.1 之后是否长出 HTTP contract 无法核实。
   **决策：自定义 RJ-contract-v1 REST**（见第 3 节），URL 带版本号；「上游 HTTP
   contract 对齐核查」降级为 R1 入口检查项（网络恢复时做，不阻塞 R0/R1）。
3. **鉴权模式**复用现有课程 API（`app/api/courses/[id]/route.ts`）：浏览器不直连
   Supabase；routes 内 `getServerSupabase()` 取登录用户 → `getServiceSupabase()`
   service role 操作数据 → 应用层显式授权。`lib/server/api-guard.ts` 提供
   `requireAuthOrTeacher(roles)` + `rateLimitByUser`；`api-response.ts` 提供
   `apiError/apiSuccess`。RuntimeStore routes 全部遵循此模式。
4. **RLS 定位**：service role 绕过 RLS，因此主授权在 API 层；RLS 是防御纵深
   （防未来有人误开 PostgREST 直连、防私有部署改用直连模式时裸奔），不是主防线。
5. **现有 Dexie 运行时数据形状**（`lib/utils/database.ts`）：
   - `ChatSessionRecord`：`{id, stageId, type, title, status, messages: UIMessage[],
     config, toolCalls, pendingToolCalls, createdAt, updatedAt, sceneId?, lastActionIndex?}`
     —— 注意它把整条消息流塞在一个 session 行里（`messages` 数组），与 RuntimeStore
     的 append-only records 模型不同，R2 映射时是「一条 UIMessage → 一条 record」；
   - `PlaybackStateRecord`：`{stageId(PK), sceneIndex, actionIndex,
     consumedDiscussions: string[], updatedAt}` —— 每 stage 一行快照，适合映射为
     kind=`playback` 的单会话（app-owned payload，DSL 骨架不校验）。

---

## 1. Supabase schema（DDL）

### 1.1 `runtime_sessions`

```sql
create table runtime_sessions (
  id                  text        primary key,           -- 客户端生成
  runtime_dsl_version integer     not null,              -- 服务端盖戳 RUNTIME_DSL_VERSION
  kind                text        not null,              -- 'chat' | 'quizAttempt' | RJ 自有 kind
  stage_id            text        not null,
  learner_key         uuid        not null,              -- = auth.uid()，分区键
  status              text        not null
                      check (status in ('active','completed','archived')),
  created_at          timestamptz not null,
  updated_at          timestamptz not null,
  app_meta            jsonb       not null default '{}'  -- RJ 应用自有扩展位，不进契约
);

-- 分区列举：listSessions(stageId, learnerKey) 按 createdAt 升序
create index runtime_sessions_by_stage_learner
  on runtime_sessions (stage_id, learner_key, created_at, id);
-- mergeLearner / deleteLearnerRuntime 扫描
create index runtime_sessions_by_learner on runtime_sessions (learner_key);
-- deleteStageRuntime 级联钩
create index runtime_sessions_by_stage on runtime_sessions (stage_id);
```

设计说明：
- `learner_key` 用 `uuid`（Supabase auth.users.id 是 uuid）。若未来私有化部署的
  IdP 不是 uuid，改列类型即可，契约层 `learnerKey: string` 不变。
- `created_at/updated_at` 用 `timestamptz` 而非 text：browser 后端专门处理过
  「ISO 字符串排序 ≠ 时刻排序」（带数字时区偏移时），timestamptz 天然按时刻排序，
  序列化回 `.toISOString()`（UTC Z）后字符串序与时刻序一致，消除这一整类坑。
- `app_meta` 是 RJ 扩展位（例如从 `ChatSessionRecord` 迁移期需要暂存的 `title`/
  `config` 引用），**不进 RuntimeSession 信封**，不参与契约校验。

### 1.2 `runtime_records`

```sql
create table runtime_records (
  session_id   text        not null references runtime_sessions(id) on delete cascade,
  seq          integer     not null,
  id           text        not null,                     -- 客户端生成，幂等键
  scene_id     text,
  action_index integer,
  sub_anchor   text,
  created_at   timestamptz not null,
  payload      jsonb       not null,                     -- JSON null 是合法值（契约允许
                                                         -- payload:null，不允许缺省）
  primary key (session_id, seq)                          -- 回放序 = 主键序（CAS 安全网）
);

-- 幂等重试去重：同一 record id 全局唯一（RJ-contract-v1 强化，见 2.3）
create unique index runtime_records_id_unique on runtime_records (id);
-- listRecords(sessionId, {sceneId}) 的过滤
create index runtime_records_by_session_scene
  on runtime_records (session_id, scene_id) where scene_id is not null;
```

设计说明：
- 主键 `(session_id, seq)` 复刻 browser 的复合 keyPath——`listRecords` 按主键序
  返回即为 seq 序，无需额外排序键。
- `payload jsonb not null` 存的是「JSON 值」，契约上的 `payload: null` 落库为
  jsonb 的 `'null'::jsonb`，与 SQL NULL 可区分；NOT NULL 约束挡的是「缺字段」
  这种写入 bug。
- `id` 全局唯一索引是**服务端幂等键**，browser 后端没有这层（它 PK 不含 id）——
  这是 RJ-contract-v1 对弱网重试的强化，不改契约形状，只加服务端行为。

### 1.3 RLS（防御纵深）

```sql
alter table runtime_sessions enable row level security;
alter table runtime_records  enable row level security;

-- learner 只能碰自己的分区（select/insert/update/delete 同谓词）
create policy runtime_sessions_self on runtime_sessions
  for all using (learner_key = auth.uid())
  with check (learner_key = auth.uid());

create policy runtime_records_self on runtime_records
  for all using (
    exists (select 1 from runtime_sessions s
            where s.id = session_id and s.learner_key = auth.uid())
  );
```

- 生产路径下 service role 不走 RLS，这些策略平时不生效；
- **不开**任何 teacher 例外策略——教师班级聚合视图走 API 层 service role +
  `requireAuthOrTeacher(['teacher','admin'])` + 显式课程归属/指派判定（与课程
  API 同模式）。RLS 里开教师口子等于把多租户隔离逻辑写进两处，必然后患。

---

## 2. seq/CAS 与幂等的服务端分配

### 2.1 appendRecord 事务（核心）

```sql
-- 伪 SQL，实现在数据访问层（见第 6 节）一个 function 内：
begin;
-- 1) 锁父会话行：存在性 + 版本守护 + active 判定 + 并发串行化，一次完成
select * from runtime_sessions where id = $1 for update;
--    不存在            → 404 NOT_FOUND
--    version > current → 409 FUTURE_VERSION
--    version < current → 事务内 migrateRuntime 后 update 回原行（同 browser 语义）
--    status <> active  → 409 INACTIVE_SESSION
-- 2) 按父会话 kind 过 payload validator（应用代码内做，见 2.4）
-- 3) 分配 seq 并插入；行锁保证同一 session 的并发 append 串行
insert into runtime_records (session_id, seq, id, scene_id, action_index,
                             sub_anchor, created_at, payload)
select $1, coalesce(max(seq), -1) + 1, $2, $3, $4, $5, $6, $7
from runtime_records where session_id = $1
returning *;
commit;
```

- `select ... for update` 把「同会话并发 append」串行化——两个并发请求拿到
  不同 seq，不出现主键冲突；`(session_id, seq)` 主键是最后一道安全网。
- browser 用 `openKeyCursor(..., 'prev')` 取最大 key 同理；SQL 的 `max(seq)` 在
  行锁保护下等价。
- **不**在 append 时触碰 `sessions.updated_at`（与 browser 语义对齐，避免回放
  时序歧义）。

### 2.2 createSession 冲突语义

契约：重复 id 是调用方 bug，不是 upsert。`insert` 撞主键 → 409 CONFLICT。
browser 在事务内先 get 再 add 是为了确定性报错；Postgres 主键冲突本身就是
确定性的，直接靠约束。

### 2.3 幂等键（append 重试去重）

弱网重试会产生「同一 record id、相同内容」的重复 POST。RJ-contract-v1 行为：

- 撞 `runtime_records_id_unique` 且**已有行的 payload/锚点字段与请求一致**
  → 200 返回已存在行（幂等成功，客户端视为已送达）；
- id 相同但**内容不同** → 409 `IDEMPOTENCY_CONFLICT`（客户端 id 生成器出 bug，
  fail-loud）。

这是对 browser 语义的纯增量（browser 靠 (sessionId, seq) 主键，不管 id），
契约测试套件不受影响（套件不测重复 id append）。

### 2.4 payload validator 单一来源

新建 `lib/runtime/payload-validators.ts`：默认 `{ chat: isChatMessageSkeleton 包装,
quizAttempt: isQuizAttemptSkeleton 包装 }`，RJ 自有 kind（如 `playback`、多智能体
课堂的自定义 kind）在此注册。browser `BrowserRuntimeStore` 的 `payloadValidators`
配置与服务端 routes **从同一个模块取**，杜绝两端校验漂移。widened scene kind 的
方案 A 先例（`lib/dsl-extensions/validate.ts` 只吞 unknown-kind 判别错误 + 自有
内容校验 fail-loud）同样适用于此：validator 只管 payload 形状，信封校验走上游
`validateRuntimeRecord/Session`。

---

## 3. RJ-contract-v1 REST（URL 版本化）

Base：`/api/runtime/v1/`。方法与 RuntimeStore 接口 1:1 映射：

| 契约方法 | 路由 | 说明 |
|---|---|---|
| `createSession` | `POST /sessions` | body = SessionInit（不含 runtimeDslVersion）；服务端盖戳；409 CONFLICT |
| `getSession` | `GET /sessions/{id}` | 404 / 200（读取迁移后返回） |
| `listSessions` | `GET /sessions?stageId=` | learnerKey 由服务端取 auth.uid()，**忽略并覆盖** body/query 中的 learnerKey（不自报家门，杜绝越权枚举）；教师代查走单独授权路由（R3 聚合视图再做，本期不做） |
| `setSessionStatus` | `PATCH /sessions/{id}/status` | body `{status, updatedAt}`；updatedAt 由调用方给（store 无时钟） |
| `deleteSession` | `DELETE /sessions/{id}` | 幂等，级联 records |
| `appendRecord` | `POST /sessions/{id}/records` | body = RecordInit；返回含 seq 的完整 record；幂等语义见 2.3 |
| `listRecords` | `GET /sessions/{id}/records?sceneId=` | seq 序 |
| `mergeLearner` | `POST /learners/merge` | body `{fromLearnerKey}`；toLearnerKey 强制 = auth.uid()；授权见第 5 节 |
| `deleteLearnerRuntime` | `DELETE /learners/me/stages/{stageId}` | 仅自身分区 |
| `deleteStageRuntime` | —（不暴露给浏览器） | 仅服务端内部调用：课程删除流程的级联钩（见 4.3） |

横向约定：
- **鉴权**：每个路由 `requireAuthOrTeacher(['learner','teacher','admin'])`（运行时
  数据 learner 是主写入方，不能用 api-guard 默认的 teacher/admin 白名单）+
  `rateLimitByUser`（append 建议 60 次/分/用户，课堂高频互动场景留足余量）；
- **错误码映射**（复用 `api-response.ts` 形状，新增 errorCode）：
  `NOT_FOUND 404`、`CONFLICT 409`、`FUTURE_VERSION 409`、`INACTIVE_SESSION 409`、
  `IDEMPOTENCY_CONFLICT 409`、`INVALID_ENVELOPE 400`（信封/payload 校验失败，
  details 带 validator 错误列表）、`VALIDATION 400`；
- **版本戳**：服务端从 `@openmaic/dsl` import `RUNTIME_DSL_VERSION`，与
  browser 客户端同源——客户端升级先于此服务端部署时，FUTURE_VERSION 写保护
  自动生效，等服务端 redeploy 即可，不需要人工干预；
- **URL 版本号 `/v1/`**：上游若日后长出官方 HTTP contract，另起 `/v2/` 或对齐
  迁移，不撕裂线上 v1 客户端（回应路线图开放问题 1）。

---

## 4. DocumentStore 服务端化（合并设计，本期只定 schema 与语义）

> 路线图第 5 节：与 R0 合并设计，实施在 B2.3 之后。本节定 schema + 版本线语义 +
> 与现有课程云同步表的关系问题，不定 routes 细节。

### 4.1 schema

```sql
create table document_stages (
  id          text        primary key,        -- stageId
  dsl_version integer     not null,           -- 文档线版本戳（与 runtime 线分离）
  stage       jsonb       not null,           -- StageRow（splitDocument 的 stage 部分）
  created_by  uuid        not null,           -- 授权锚点（归属/分享判定复用课程 API 模式）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table document_scenes (
  stage_id    text  not null references document_stages(id) on delete cascade,
  id          text  not null,
  order_index integer not null,               -- reassemble 按 order 排序，冗余成列
  scene       jsonb not null,
  primary key (stage_id, id)
);

create table document_outlines (
  stage_id text primary key references document_stages(id) on delete cascade,
  outlines jsonb not null
);
```

对应 `packages/@openmaic/storage/src/document/adapter.ts` 的
`splitDocument/reassembleDocument`：`stageRow` 带 `dslVersion` 戳、scenes 复合键
`(stageId, id)`、outlines 按 stageId 单行。

### 4.2 语义对齐 browser.ts 文档后端

- 写入盖 `DSL_VERSION` 戳（写 stage 行时）；
- 读取迁移（`migrateDocument`），未来版本读放行、写拒绝（FUTURE_VERSION 409）；
- **RJ widened-kind 门禁必须出现在服务端写入边界**：调
  `lib/dsl-extensions/validate.ts` 的 `validateSceneExtended`——interactive/pbl
  只吞 unknown-kind 判别错误，内容校验（https url / 非空 html / projectConfig
  对象）fail-loud。b2.2 的教训：脏数据（`1I_kD25GX1` 的伪 text action）一旦绕过
  校验入库，修复成本是人工修生产数据。服务端是最后一道闸；
- 一次 `saveDocument` = 一个 Postgres 事务写 stage + scenes + outlines 三组行，
  对齐 browser 后端的 txRun 原子性。

### 4.3 与现有课程云同步的关系（开放问题，B2.3 后评审时拍板）

RJ 已有自己的课程→Supabase 云同步（含 TTS 资源发布链路，今天刚踩过
`missing-audio-url` 的坑）。DocumentStore 服务端 adapter 落地时两者关系三选一：
A) adapter 替换现有同步（统一走契约路径）；B) 并存（契约路径供编辑器，
   现有发布链路不动）；C) 现有同步逐步迁入 adapter。**本期不拍**，R0 只要求
   schema 设计不与现有表冲突（新表独立命名，无共享外键）。
`deleteStageRuntime` 届时作为课程删除的服务端内部级联钩接入。

---

## 5. mergeLearner 服务端实现（access code → 账号绑定）

场景：学员先用 6 位 access code 进课堂（产生 runtime 数据，learnerKey = 临时 key），
后绑定/登录账号，数据并入 `auth.uid()` 分区。

```sql
-- 单事务实现（数据访问层 function）：
begin;
-- 未来版本守护：任一 from 行 version > current → 409，整并中止（browser 同语义：
-- 宁可响亮失败也不污染目标分区）
select id from runtime_sessions
 where learner_key = $1 and runtime_dsl_version > $current limit 1;
-- 自合并 → 0，不开事务（浏览器同语义）
update runtime_sessions set learner_key = $2 where learner_key = $1;
-- 返回 affected rows
commit;
```

授权问题（R0 拍板项）：`fromLearnerKey` 不能由客户端随意自报（否则可劫走任意
匿名分区的数据）。**设计：merge 请求必须携带绑定流程下发的短期 merge token**
——access code 绑定接口（已有/将有）在绑定成功时签发
`{fromLearnerKey, toLearnerKey, exp}` 的服务端签名 token（或存一张
`runtime_merge_grants` 表，一次性使用）。routes 验 token 才执行 merge。
**无 token 一律 403**，即使 from==to 之外的情况也一样。

---

## 6. 数据访问层与私有化可替换（回应开放问题 5）

- 所有 SQL 集中在一个模块 `lib/server/runtime-store-pg.ts`（接口 =
  RuntimeStore 方法集的 server 版），routes 不直接碰 Supabase client；
- 模块内部用 `getServiceSupabase()` 的 PostgREST RPC / 或 node-postgres 直连
  （二选一，实现期定；DDL 是纯 Postgres，无 Supabase 专有类型，除 RLS 策略里的
  `auth.uid()`——私有化部署时用应用层中间表或自定义 claims function 替换，
  DDL 本身不动）；
- 私有化推论：办公区 GFW 已实证 GitHub/Vercel 可达性风险，私有化环境大概率同样
  不通 Supabase 云服务——因此 R4 不是「可选增强」而是「必选项」，本期 schema
  设计已按「纯 Postgres 可自建」约束（无 Supabase extension 依赖、无外网调用）。

---

## 7. 容量与留存（回应开放问题 3）

估算（chat 为主）：
- 单条 chat record payload ≈ 1–4 KB（UIMessage JSON）；一节课 40 学员 × 30 条
  互动 ≈ 1200 条 ≈ 2.5–5 MB；一个学期 200 课次 ≈ 0.5–1 GB 量级。
- quizAttempt 比 chat 低一个数量级。

结论：容量**不是**近两年的瓶颈，不需要分区表。留存策略（建议，评审确认）：
1. 课程结束后由教师/系统将会话 `status → archived`（契约原生支持），
   archived 数据保留 24 个月；
2. 超期数据导出对象存储（JSONL）后 `deleteLearnerRuntime/deleteStageRuntime`
   物理清理——导出归档脚本列入 R4 前的运维清单，本期不做；
3. `runtime_records` 预计是最大表，索引已按查询模式精简（3 个），无过度索引。

---

## 8. 弱网 outbox 与重试（回应开放问题 4）

分阶段：
- **R2 影子期**：影子写 fire-and-forget，失败丢弃 + `ClientDiagnostics` 计数
  （同 b2.1/b2.2 的 document_bridge/parity 遥测模式），读源仍是 Dexie，丢影子
  写无业务影响；
- **R3 读切换前必须落地**：IndexedDB outbox 队列——append 先入本地队列（含
  客户端生成的 record id），后台 flush：`POST` 成功或收到幂等 200 才出队；
  指数退避（1s/2s/4s…上限 5min），`visibilitychange`/`online` 事件触发补 flush。
  服务端幂等键（2.3）保证 flush 重试不双写。**R3 评审时 outbox 未落地则不准
  切读源**，写进验收门禁。

---

## 9. R1 入口检查项（开工前逐条确认）

1. 网络恢复时核查上游 v0.3.1 之后是否出现官方 HTTP storage contract；若有，
   评估 RJ-contract-v1 与它的字段级差异，决定对齐或维持 v1（URL 版本号已兜底）；
2. 复用上游 `packages/@openmaic/storage/test/runtime-contract.ts` 测试套件对
   服务端后端跑全量——套件即验收标准，不另写行为断言；
3. `lib/runtime/payload-validators.ts` 的 RJ 自有 kind 清单（`playback` 等）与
   多智能体课堂实际使用的 kind 对齐，避免 R2 接入时才发现 validator 缺口；
4. api-guard 的 learner 角色放行是新用法，检查现有路由是否有「默认 teacher/admin
   白名单」的隐式假设会被误复用。

---

## 10. 验收标准（R0 评审勾选单）

- [ ] DDL（1.1/1.2/4.1）过评审，索引与约束无争议；
- [ ] RLS 定位（防御纵深、不开教师口子）确认；
- [ ] seq/CAS（2.1）与幂等键（2.3）语义确认；
- [ ] RJ-contract-v1 路由表（第 3 节）与错误码映射确认；
- [ ] mergeLearner 授权（merge token，第 5 节）拍板；
- [ ] 留存策略（第 7 节）确认或调整；
- [ ] outbox 门禁（R3 前必须落地）写入路线图验收；
- [ ] 4.3 的开放问题明确「B2.3 后评审时拍板」，不阻塞本期。
