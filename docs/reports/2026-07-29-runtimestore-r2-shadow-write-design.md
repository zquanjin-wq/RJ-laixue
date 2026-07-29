# R2 设计稿：RuntimeStore 影子双写（Shadow Write）

> 日期：2026-07-29 ｜ 状态：**设计稿，待 Codex 评审**（R1.1 终审许可：允许开 R2，
> 仅限先出设计稿，不直接实施）
> 前置：R0（已拍板）→ R1/R1.1（已签字，`52862d2e`）
> 本文档逐条覆盖终审提出的六个必答点。范围纪律：不含任何 Supabase 迁移执行；
> 不含读源切换；影子写实施需本稿评审通过后另行开卡。

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
- **裁剪（已知且有意）**：`title/config/toolCalls/pendingToolCalls` 是 RJ 应用层
  字段，不在 RuntimeSession 信封内，R1.1 最终 schema 也无 `app_meta` 列。
  影子期**不带**这些字段；R3 读切换前若确需保留，另开评审决定进
  独立元数据 record 还是扩展列——不阻塞 R2。
- **增量写的折叠**：Dexie 是整行覆写（每发一条消息 messages 全量回写），
  影子写客户端维护「已影子化的 message.id 集合」（内存 + IndexedDB 标记位），
  每次只把**新增** message 转成 append 调用——把覆写模型折叠成 append-only。

### 1.2 quizAttempt：localStorage → 单会话 + 相位 records

- **一个 scene 的一次答题周期 → 一个 `RuntimeSession`**：
  `id = qa:<stageId>:<sceneId>:<learnerLocalId>`（确定性，retry 重开周期换新 id）；
  `kind = 'quizAttempt'`；提交时 `status: active → completed`。
- **相位迁移 → records**（对齐 `QuizAttemptSkeleton { phase, answers }`）：
  - 提交（`writeSubmittedAnswers`）→ record payload `{ phase: 'answering', answers }`，
    `record.id = <sessionId>:submit`，锚点 `sceneId`；
  - 批改完成（`writeSubmittedResults`）→ record payload
    `{ phase: 'reviewing', answers, results }`（results 是 app-owned 评分细节，
    骨架只查 phase + answers 形状），`record.id = <sessionId>:grade`；
  - retry（`clearSubmitted`）→ 会话 `archived`，下周期新会话 id。
- **draft 不影子化**：答题中草稿高频多变且无业务价值，只在提交时刻落 record
  （与 localStorage 现有生命周期一致）。

### 1.3 playback：PlaybackStateRecord → 单会话快照 records

- **一个 stage → 一个 `RuntimeSession`**：`id = pb:<stageId>`（每学员分区天然隔离），
  `kind = 'playback'`，status 常 `active`。
- **每次进度推进 → 一条 record**：payload = 整份快照
  `{ sceneIndex, actionIndex, consumedDiscussions }`（app-owned 形状），
  `record.id = pb:<stageId>:<monotonic-n>`（客户端计数器）；读时取最后一条即现状。
  快照语义天然适配 append-only，无需折叠。

### 1.4 匿名学员的 learnerKey

匿名期（access-code 验证通过但未登录）影子写**不启动**——R2 的影子写只覆盖
已登录学员。匿名期数据留在本地，绑定登录后由 merge 链路处理（第 6 点）。
理由：匿名写服务端需要匿名会话授权机制，超出 R2 范围，且 RJ 课堂主流程
（redeem 绑定）已是登录态。

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

- **record id 确定性生成是 R2 的硬门禁**（第 1 节各规则）：
  `<sessionId>:<message.id>`、`qa:…:submit|grade`、`pb:<stageId>:<n>`——
  全部可由内容推导，任何重试/刷新/重进都生成同一个 id，服务端幂等键
  （`runtime_records_id_unique` + IDEMPOTENCY_CONFLICT 语义，R1.1 已验证）
  保证不双写。
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

## 6. merge 签发端对接（终审查点 ⑥）

对接点 = `app/api/access-code/redeem/route.ts`（绑定成功处，R1.1 已留好
`runtime_merge_grants` 表与 `runtime_merge_with_grant` 原子函数）：

1. redeem 绑定成功（含 `alreadyBound` 幂等路径之外的首次绑定）后，同一路由内
   用 service role 插入 grant 行：
   `id = ulid()`、`from_learner_key = ac:<code>`、`to_learner_key = auth.uid()`、
   `expires_at = now() + 15 minutes`；
2. redeem 响应增加 `mergeGrant: { grantId, fromLearnerKey, expiresAt }` 字段；
3. 客户端拿到后调 `POST /api/runtime/v1/learners/merge { fromLearnerKey, grantId }`；
   `version_conflict` 由路由自动迁移重试（R1.1 已实现）；客户端对 403 静默
   （grant 过期/已用不影响主流程）；
4. **匿名 learnerKey 约定**：`ac:<ACCESS_CODE>`——access-code 是学员在绑定前
   的唯一稳定身份锚点，且 redeem 流程天然持有它。匿名期若产生服务端 runtime
   数据（R2 不覆盖，见 1.4；R3+ 若开放匿名写），其分区键即此值，merge 后并入
   `auth.uid()` 分区；
5. grant 一次性、15 分钟、仅 service role 可写（RLS 无可见策略，R1.1 已落地）；
   绑定流程是**唯一**签发端，任何其他路径不得插入 `runtime_merge_grants`。

## 7. R2 实施边界（评审通过后开卡的施工范围）

- 只做：`lib/runtime/shadow-writer.ts` + 三个写路径挂点 + ClientDiagnostics
  `runtime_shadow` 指标 + redeem 签发端（第 6 点 1–2）+ 开关
  （`NEXT_PUBLIC_RUNTIME_SHADOW`，默认关）+ 对应 vitest（id 生成确定性、
  折叠逻辑、遥测分母）；
- 不做：迁移执行、读切换、双读比对基础设施（那是第 5 点第 3 条的独立卡）、
  outbox、匿名写、教师聚合视图；
- 验收：影子写全链路在预览环境可观测（指标上报），本地读源零改动回归全绿。

## 8. 待评审拍板的开放问题

1. 1.1 的字段裁剪（title/config/toolCalls 影子期不带）是否接受？
2. 匿名 learnerKey 取 `ac:<code>` 是否认可（第 6.4 条）？
3. 1.4「匿名期不影子写」是否认可？若业务要求匿名期也上服务端，R2 范围需
   追加匿名授权机制设计（工作量显著增加）；
4. 灰度开关形态：环境变量够用，还是要站点配置表（运行时切换）？
