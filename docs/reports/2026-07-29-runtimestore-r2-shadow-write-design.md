# R2 设计稿：RuntimeStore 影子双写（Shadow Write）

> 日期：2026-07-29 ｜ 状态：**设计稿 v2.1（含 Codex 验收卡勘误，2026-07-30）**
> 前置：R0（已拍板）→ R1/R1.1（已签字，`52862d2e`）
> 本文档逐条覆盖终审提出的六个必答点。范围纪律：不含任何 Supabase 迁移执行；
> 不含读源切换；影子写实施按本稿开卡（仅影子写、默认关闭、本地读源不动）。
>
> **v2.1 勘误（Codex R2 验收卡，2026-07-30）：**
> ⓵ quizAttempt phase 枚举：本稿 1.2 的 `answering`/`reviewing` 是本地
>    `SubmittedState.kind` 词表，**不能发送给服务端**；DSL `QuizAttemptPhase`
>    枚举为 `'draft'|'submitted'|'reviewed'`。实施已按 DSL 枚举（submitted/
>    reviewed），本稿相应行作废，以实施为准。Codex 已认可实施。
> ⓶ **playback 移出 R2**，另立 R2.1/R3 前置卡：初版实现只在单次函数调用内
>    重试复用 eventId，Dexie 中的 eventId 无读回路径，测试未覆盖刷新恢复——
>    不满足「任何重试/刷新/跨标签页恢复都取回同一个 id」的硬门禁；补恢复
>    实质是建设 pending/outbox，与 R2 排除 outbox 的边界冲突。本稿 1.3 节
>    及各处 playback 内容仅作 R2.1 设计素材保留，**不属于 R2 范围**。
> ⓷ quiz attemptId 持久化升级为**单键提交 envelope**（见 1.2）：初版
>    `setItem(attemptId)+setItem(answers)` 双键写不具备跨键原子性，
>    第二次失败会留下孤立 attemptId。改为 `quizAnswers:<sceneId>` 单键
>    envelope `{v, attemptId, answers}` 一次原子写入；影子路径只认持久化
>    读回的 envelope，写失败即跳过，禁止使用调用方内存数据。
>
> **v2 修订记录（Codex 终审四项拍板 + 两条 P0，2026-07-29）：**
> ① 字段裁剪接受，仅限 R2 影子期——影子数据不能作为未来读源或完整审计依据，
>    R3 切读前必须另行评审补齐完整消息语义（1.1）；
> ② `ac:<code>` 匿名键约定**否决并删除**——access code 是凭证，不得作分区键、
>    grant 响应字段或日志内容；未来匿名写用服务端签发的随机不透明 ID（1.4/6）；
> ③ 匿名期不影子写接受——redeem 的 merge-grant 签发**移出 R2 施工范围**，
>    保留为后续匿名 RuntimeStore 的设计前提（6/7）；
> ④ 开关用环境变量 `NEXT_PUBLIC_RUNTIME_SHADOW`，默认关，不建站点配置表（7）；
> ⑤ P0：playback 的事件 id 改为随快照持久化到 Dexie 的 `runtimeShadowEventId`
>    （UUID），不得用内存单调计数器（1.3）——**已随 playback 一并移出 R2（v2.1-⓶）**；
> ⑥ P0：quiz 的 `learnerLocalId` 未定义，改为每个答题周期在 localStorage
>    持久化的 `attemptId`（1.2）——**已升级为单键 envelope（v2.1-⓷）**。
>    确定性一律建立在持久化字段上，不建立在内存变量上。

---

## 0. 现状盘点（设计基线，一手事实）

| 数据类 | 现存储 | 形状 | 映射目标 kind |
|---|---|---|---|
| 课堂对话 | Dexie `chatSessions` | 一行一个会话，`messages: UIMessage[]` **整条消息流塞在行内**，另有 `type/title/config/toolCalls/pendingToolCalls/sceneId/lastActionIndex` | `chat` |
| 测验答题 | **localStorage**（不在 Dexie）`quizDraft/quizAnswers/quizResults:<sceneId>` | draft=答题中；answers=提交时一次性写；results=批改后一次性写 | `quizAttempt` |
| 播放进度 | Dexie `playbackState` | 每 stage 一行快照（sceneIndex/actionIndex/consumedDiscussions） | `playback`（app-owned，无骨架校验） |

**重要更正：** 终审第 1 点提的「quizAttempt 的 Dexie 记录」实际不存在——
quiz 数据在 localStorage，且提交前只有 draft。R2 的 quizAttempt 映射因此是
「**新建持久化链路**」而非「搬迁既有 Dexie 记录」，影子期 localStorage 仍是
读源，RuntimeStore 只是多写一份。

契约侧已有准备（R1.1 落地）：`chat`/`quizAttempt` 走 DSL 骨架校验
（`isChatMessageSkeleton` / `isQuizAttemptSkeleton`），`playback` 为 app-owned
不校验（`lib/runtime/payload-validators.ts` 单一来源，两端不漂移）。

## 1. 映射规则（终审查点 ①）

### 1.1 chat：ChatSessionRecord → RuntimeSession + N records

- **一条 `ChatSessionRecord` → 一个 `RuntimeSession`**：`id` 直用 Dexie 会话 id
  （已是客户端生成的全局 id）；`stageId` 直用；`status` 映射
  `active/completed/archived` 同名值；`learnerKey` 由服务端强制 = auth.uid()。
- **一条 `UIMessage` → 一条 `RuntimeRecord`**：`record.id = <sessionId>:<message.id>`
  （确定性生成，重试幂等的关键，见第 4 点）；`payload = { role, content }`
  （ChatMessageSkeleton 子集）；锚点：`sceneId` 取自会话级 `sceneId`，
  `actionIndex` 取自消息在数组中的下标（回放序 = seq 序，天然一致）。
- **裁剪（终审拍板，仅限 R2 影子期）**：`title/config/toolCalls/pendingToolCalls`
  是 RJ 应用层字段，不在 RuntimeSession 信封内，R1.1 最终 schema 也无
  `app_meta` 列。影子期**不带**这些字段。推论两条（Codex 原话入档）：
  **影子数据不能作为未来读源或完整审计依据**；R3 切读前必须另行评审并补齐
  完整消息语义（至少明确 toolCalls、config 等是否要保存、以什么形态保存）。
- **增量写的折叠**：Dexie 是整行覆写（每发一条消息 messages 全量回写），
  影子写客户端维护「已影子化的 message.id 集合」（内存 + IndexedDB 标记位），
  每次只把**新增** message 转成 append 调用——把覆写模型折叠成 append-only。

### 1.2 quizAttempt：localStorage → 单会话 + 相位 records

- **一个 scene 的一次答题周期 → 一个 `RuntimeSession`**：
  `id = qa:<stageId>:<sceneId>:<attemptId>`。
  **`attemptId` 的生成与持久化（P0，终审判定；v2.1 验收卡修订为单键 envelope）**：
  每个答题周期提交时生成一个 UUID，与 answers 一起以**单键提交 envelope**
  `{v, attemptId, answers}` 一次 setItem 原子写入 `quizAnswers:<sceneId>`
  （初稿的独立键 `quizAttemptId:<sceneId}` 双键方案已废弃——两次 setItem
  不具备跨键原子性，第二次失败会留下孤立 attemptId）；整个周期（含任何
  重试/刷新/跨标签页恢复）只复用这个持久化值；`clearSubmitted` 删除
  envelope 之后才允许生成新 id。**确定性建立在持久化字段上，不建立在
  内存变量上**——内存态的「当前周期 id」在刷新后丢失会导致同周期生成两个
  会话 id，服务端出现重复周期。`kind = 'quizAttempt'`；提交时
  `status: active → completed`。
- **相位迁移 → records**（对齐 `QuizAttemptSkeleton { phase, answers }`）：
  - 提交（`writeSubmittedAnswers`）→ record payload `{ phase: 'submitted', answers }`
    （v2.1 勘误：DSL `QuizAttemptPhase` 枚举为 draft/submitted/reviewed，
    初稿的 'answering' 是本地 SubmittedState 词表，不能发送给服务端），
    `record.id = <sessionId>:submit`，锚点 `sceneId`；
  - 批改完成（`writeSubmittedResults`）→ record payload
    `{ phase: 'reviewed', answers, results }`（results 是 app-owned 评分细节，
    骨架只查 phase + answers 形状），`record.id = <sessionId>:grade`；
  - retry（`clearSubmitted`）→ 会话 `archived`，下周期新会话 id。
  影子路径的 **attemptId 与 answers 只从持久化 envelope 读回**（写失败 /
  legacy 裸 answers 读不到即跳过）；results 在 R2 影子期取自调用方参数，
  与 `writeSubmittedResults` 的持久化写同刻发生，漂移风险可接受
  （Codex 2026-07-30 验收确认：不构成 P0）。
- **draft 不影子化**：答题中草稿高频多变且无业务价值，只在提交时刻落 record
  （与 localStorage 现有生命周期一致）。

### 1.3 playback：PlaybackStateRecord → 单会话快照 records

- **一个 stage → 一个 `RuntimeSession`**：`id = pb:<stageId>`（每学员分区天然隔离），
  `kind = 'playback'`，status 常 `active`。
- **每次进度推进 → 一条 record**：payload = 整份快照
  `{ sceneIndex, actionIndex, consumedDiscussions }`（app-owned 形状）。
  **record id 的生成与持久化（P0，终审判定）**：每次保存进度**之前**生成一个
  新 UUID `runtimeShadowEventId`，**随快照一起持久化到 Dexie 的
  `playbackState` 行**（行加同名字段）；影子写用
  `record.id = pb:<stageId>:<runtimeShadowEventId>`；重试只能复用这个已持久化
  的 id，下一次保存必须生成新 id。原方案的内存单调计数器
  `pb:<stageId>:<monotonic-n>` **否决**——刷新、跨标签页或计数器丢失会复用
  旧序号撞幂等键（不同内容 → `IDEMPOTENCY_CONFLICT`）。
  读时取最后一条即现状；快照语义天然适配 append-only，无需折叠。

### 1.4 匿名学员（终审拍板：R2 不覆盖，且不定任何匿名键约定）

匿名期影子写**不启动**——R2 只覆盖 `auth.uid()` 已登录用户（`/api/access-code/
redeem` 本身就要求 Supabase 登录，范围一致）。匿名期数据留在本地。
**原 `ac:<code>` 匿名 learnerKey 约定删除**（终审否决：access code 是凭证，
绝不能作为数据库分区键、grant 响应字段或日志内容）。未来若开放匿名服务端
写，匿名身份采用**服务端签发的随机不透明 ID**（如 `ac:<uuid>`），绝不使用
原始 code；该机制与匿名数据迁移合并，另立任务（见第 6 节）。

## 2. 影子写失败 / 超时 / 重复写行为（终审查点 ②）

影子写客户端 = 新模块 `lib/runtime/shadow-writer.ts`（模式类比 B2.1 的
DocumentBridge 影子复制），挂在现有三个写路径上（chat 发送、quiz 提交/批改、
playback 推进），**读源完全不动**。

- **fire-and-forget**：影子写不 await 进业务流程，不阻塞 UI；失败**静默丢弃**
  （读源在本地，丢影子写无业务影响）。
- **超时**：每次调用 8s `AbortController`；超时按失败处理（丢弃 + 遥测）。
- **重复写**：所有 record id 确定性生成（第 1 节），重试/重发撞服务端幂等键：
  同内容 → 服务端返回已有行（视为成功）；不同内容 → `IDEMPOTENCY_CONFLICT`
  → 计数并保留现场（说明客户端 id 生成出 bug，fail-loud 不自动修复）。
- **授权失败（401/403）**：不重试（登录态问题，重试无意义），遥测区分计数。
- **R2 期不做 outbox**（R0 第 8 节已拍板：outbox 是 R3 切读源前的门禁，
  影子期丢失可接受——影子数据本来就是冗余）。

## 3. 诊断指标与成功率分母（终审查点 ③）

复用 `ClientDiagnostics` 通道（`/api/client-diagnostics`，B2.1/B2.2 同模式），
新指标名 `runtime_shadow`：

| 字段 | 取值 |
|---|---|
| `outcome` | `ok` / `ok_idempotent`（撞幂等键同内容）/ `idempotency_conflict` / `validation` / `auth` / `timeout` / `http_4xx` / `http_5xx` / `network` |
| `op` | `create_session` / `append_record` / `set_status` |
| `kind` | `chat` / `quizAttempt` / `playback` |
| `durationBucket` | `lt_1s` / `gte_1s` |
| `shadowVersion` | `r2.1` |

**分母**：成功率 = `ok + ok_idempotent` / 全部影子写尝试（按 `op`/`kind`
分别计）。`ok_idempotent` 计入成功（重试幂等送达是设计行为，不是失败）。
**R2 期不设 SLO 门禁**——指标只用于观察和为 R3 切读源决策提供数据
（第 5 点的 99% 门槛以这里的数据为准）。

## 4. 弱网 outbox / 重试 / 幂等 record id 门禁（终审查点 ④）

- **record id 可复现生成是 R2 的硬门禁**（第 1 节各规则，含终审两条 P0 修订）：
  `<sessionId>:<message.id>`（message.id 本身持久化在 Dexie 行内）、
  `qa:…:submit|grade`（attemptId 持久化在 localStorage）、
  `pb:<stageId>:<runtimeShadowEventId>`（UUID 随快照持久化在 Dexie）——
  共同原则：**id 的「确定性」一律锚定在持久化字段上，绝不锚定在内存变量上**；
  任何重试/刷新/跨标签页恢复都取回同一个 id，服务端幂等键
  （`runtime_records_id_unique` + IDEMPOTENCY_CONFLICT 语义，R1.1 已验证）
  保证不双写、id 复用串内容时响亮失败。
- **重试**：影子写客户端对 `timeout/network/http_5xx` 做**最多 2 次**指数退避
  （1s/4s），仍败则丢弃；`validation/auth/http_4xx/idempotency_conflict` 不重试。
- **outbox**：R2 不做；重申 R0 门禁——**R3 评审时 IndexedDB outbox 未落地
  则不准切读源**（append 先入本地队列、含客户端 record id、指数退避、
  `visibilitychange/online` 补 flush、幂等 200 才出队）。R2 的确定性 id 设计
  已为 outbox 铺好路（outbox 只是给同一批调用加了持久化队列）。

## 5. 读源切换时机（终审查点 ⑤）——条件清单，全部满足才评审切换

1. 迁移已在生产执行完毕（走终审拍板的隔离预览→生产授权流程，不在 R2 范围）；
2. 影子写 `runtime_shadow` 成功率 **≥ 99%（连续 14 天，按 kind 分别达标）**；
3. **双读比对期**：对抽样学员做 Dexie/localStorage 与 RuntimeStore 的双读 diff
   （类比 B2.2 document_parity，复用 ClientDiagnostics），match 率 100% 持续 7 天；
4. IndexedDB outbox 已上线且自身遥测达标（队列深度、flush 成功率）；
5. 灰度开关按「课程 → 学员」两级灰度（站点配置，非硬编码），可一键回退到
   本地读源（回退只关开关，服务端数据保留——与终审回滚纪律一致）。

切换顺序建议：playback（最简，快照语义）→ quizAttempt → chat（最重，消息流）。

## 6. merge 签发端——后续匿名 RuntimeStore 的设计前提（终审拍板：**不在 R2 施工范围**）

R2 不做匿名影子写，服务端不存在可合并的匿名 runtime 数据，此时把 grant
签发挂进 redeem 只会无谓扩大安全面。本节保留为**设计前提记录**，待「匿名
服务端授权与迁移合并」任务（1.4）启动时按此对接：

1. 对接点 = `app/api/access-code/redeem/route.ts`（绑定成功处）。R1.1 已备好
   `runtime_merge_grants` 表与 `runtime_merge_with_grant` 原子函数（一次性、
   15 分钟、仅 service role 可写、RLS 无可见策略、version_conflict 不烧 grant、
   路由自动迁移重试）；
2. 届时 redeem 绑定成功后用 service role 插入 grant 行并在响应中携带
   `{ grantId, fromLearnerKey, expiresAt }`，客户端调
   `POST /api/runtime/v1/learners/merge`；客户端对 403 静默（不影响主流程）；
3. **fromLearnerKey 绝不允许出现原始 access code**（终审判定，见 1.4）——
   匿名分区键必须是服务端签发的随机不透明 ID；grant 响应字段与日志同样
   不得包含 code；
4. 绑定流程是**唯一**签发端，任何其他路径不得插入 `runtime_merge_grants`。

## 7. R2 实施边界（按本稿开卡的施工范围）

- 只做：`lib/runtime/shadow-writer.ts` + 三个写路径挂点（chat 发送、quiz
  提交/批改、playback 推进，含 1.2/1.3 的持久化 id 字段）+ ClientDiagnostics
  `runtime_shadow` 指标 + 开关 `NEXT_PUBLIC_RUNTIME_SHADOW`（**默认关，
  环境变量形态，不建站点配置表**——站点配置与「课程→学员」灰度是 R3
  切读源前的能力，不为影子写提前扩大控制面）+ 对应 vitest（持久化 id 的
  生成/复用/刷新恢复、折叠逻辑、遥测分母）；
- 不做：迁移执行、读切换、双读比对基础设施（第 5 点第 3 条的独立卡）、
  outbox、匿名写、redeem 的 merge-grant 签发（第 6 节）、教师聚合视图；
- 验收：影子写全链路在预览环境可观测（指标上报），本地读源零改动回归全绿。

## 8. 开放问题处置记录（终审已全部拍板，无遗留）

| 原问题 | 终审结论 |
|---|---|
| ① 字段裁剪 | 接受，仅限 R2 影子期；影子数据不作未来读源/审计依据，R3 前另行评审补齐完整消息语义（1.1） |
| ② `ac:<code>` 匿名键 | **否决**，约定删除；未来用服务端签发随机不透明 ID（1.4/6.3） |
| ③ 匿名期不影子写 | 接受；匿名授权与迁移合并另立任务（1.4） |
| ④ 开关形态 | 环境变量 `NEXT_PUBLIC_RUNTIME_SHADOW` 默认关；站点配置/灰度是 R3 能力（7） |

R3 遗留清单（非本稿范围，仅登记）：完整消息语义评审（toolCalls/config 形态）、
匿名服务端授权 + 不透明 ID + 迁移合并、站点配置表与两级灰度、双读比对
基础设施、IndexedDB outbox。
