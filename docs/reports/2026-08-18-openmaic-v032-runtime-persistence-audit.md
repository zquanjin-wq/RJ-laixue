# OpenMAIC v0.3.2 RuntimeStore / Chat / Persistence 差异审计报告

- 审计日期：2026-08-18
- 审计分支：`chore/openmaic-v032-runtime-audit`
- 本地 HEAD：`4579519bfb66a19824584119bdceb45f916bbfe9`（`test/r3-line`）
- 上游 tag/commit：`v0.3.2` / `673af150`
- merge-base：`04b70f0359ebb117deeb5e1a0f71b78eb269bc8f`
- 审计人：WorkBuddy / 老金助手
- 性质：只读审计与设计分析，不修改产品代码、SQL、环境变量，不部署

---

## §1 执行摘要

### 1.1 整体结论

**不允许整体合并 v0.3.2。** 本地 `test/r3-line` 与上游 `v0.3.2` 已经高度分叉（本地独有约 348 个提交、上游 v0.3.2 独有约 133 个提交），且双方在 RuntimeStore 读源切换、Chat 持久化、Playback 恢复模型上采用了**不同的架构假设**。整体合并必然破坏本地已签字的 R3 v1.1 五阶段状态机、Quiz 严格依赖链、Playback visit-session 语义以及 Chat shadow-only 红线。

### 1.2 立即跟进（可形成独立修复卡）

| 项 | 上游来源 | 本地状态 | 建议动作 |
|---|---|---|---|
| HTTP RuntimeStore `fetch` 显式绑定 | `packages/@openmaic/storage/src/runtime/http.ts:159-175` | 本地未复用该 package，但若未来引入同 package 则存在相同风险 | 若引入上游 `@openmaic/storage` 运行时，必须带上 `.bind(globalThis)` 修复 |
| Runtime record/session 写边界校验 | `packages/@openmaic/storage/src/runtime/http.ts:95-128`、`storage_runtime_types.ts:96-162` | 本地 outbox 仅做 JSON.stringify 冻结，无 DSL 校验 | 作为 R3.x dual-read 前置，评估是否在 outbox 入队/发送前增加 `validateRuntimeRecord`/`validateRuntimeSession` |
| 409 `RUNTIME_APPEND_CONFLICT` 结构化冲突详情 | `packages/@openmaic/storage/src/runtime/http.ts:208-227` | 本地只解析 `errorCode` 字符串 | 若后续需要自动重放/对齐 seq，可移植结构化错误 |

### 1.3 仅作参考

- Chat 的 `generation` session 模型：设计上优雅，但**与本地 R3 v1.1「chat 不得进入 dual-read」冲突**，且需要服务端/DSL 同时支持 `chat` kind 的读源切换；当前只作参考。
- Quiz 的 `QuizAttemptWriter` 防抖/队列/跨标签页锁：实现精细，但本地已签字 R3.2 使用 outbox 依赖链模型，直接替换等于重做；只吸收其测试用例作为本地 outbox 测试补充。

### 1.4 明确不得引入

- 上游把 **Chat 作为 RuntimeStore 主读源** 的整套切换（`lib/utils/chat-storage.ts` 重写、`chat-storage-core.ts`、BrowserRuntimeStore）。这与本地 `docs/reports/2026-08-02-runtimestore-r3-read-cutover-design.md` 第十三章「chat 仅 shadow、不得 dual-read」直接冲突。
- 上游 **Playback cursor 退出 Dexie** 改为 device-scoped KV（`lib/playback/cursor.ts`）。本地 R2.1 A2 已签字依赖 `playbackState` Dexie 行与事务内 eventId/CAS，切换会丢失 pending 语义。
- 上游 **Quiz 没有 outbox**，直接对 `RuntimeStore` 做同步写。本地 R3.2 已签字使用 `runtimeOutbox` + 依赖链 + succeededEntries，直接合并会丢弃严格顺序与离线恢复。

### 1.5 是否影响当前 Production shadow GO/NO-GO

**未发现新的 P0 级别阻断。** 上游 v0.3.2 的 Chat 加固（PR #1050）恰恰**佐证了本地 2026-08-02 调查报告的根因判断**（缺少 per-session 串行化导致同 ID 不同 payload）。本地当前 Chat 仍为 shadow-only，且未授权 dual-read，因此该风险已被红线兜住。上游的修复方向与本地判断一致，但具体实现与本地架构不同，不能作为“立即合入即可解除阻断”的依据。

---

## §2 基线与对比方法

### 2.1 本地基线

- 仓库：`D:/WorkBuddy 地界/RJ-laixue-storage-b2`
- 分支：`test/r3-line`
- HEAD：`4579519bfb66a19824584119bdceb45f916bbfe9`
- 状态：本地领先 `origin/test/r3-line` 4 个提交，工作树干净

### 2.2 上游基线

- 远程：`upstream https://github.com/THU-MAIC/OpenMAIC.git`
- tag：`v0.3.2` → `673af150 release: v0.3.2`
- merge-base：`04b70f0359ebb117deeb5e1a0f71b78eb269bc8f`

### 2.3 分叉度量

```text
本地独有提交（merge-base..HEAD）：        348
上游 v0.3.2 独有提交（merge-base..v0.3.2）： 133
```

### 2.4 审计过的提交

| 上游 commit | PR | 主题 | 重点 |
|---|---|---|---|
| `3eea9dc5` | #955 | learner-data cutover: quiz + playback onto RuntimeStore | Quiz/Playback RuntimeStore 化 |
| `ad30061b` | #1050 | harden runtime sync, legacy migration, and record validation | Chat runtime 加固 |
| `673af150` | release | v0.3.2 release tag | CHANGELOG、合并点 |

### 2.5 审计过的文件（上游 v0.3.2）

- `lib/quiz/runtime.ts`
- `lib/quiz/persistence.ts`
- `lib/quiz/view-state.ts`
- `lib/playback/cursor.ts`
- `lib/playback/engine.ts`
- `lib/utils/chat-storage-core.ts`
- `lib/utils/chat-storage.ts`
- `lib/utils/chat-storage-lock.ts`
- `packages/@openmaic/storage/src/runtime/http.ts`
- `packages/@openmaic/storage/src/runtime/browser.ts`
- `packages/@openmaic/storage/src/runtime/pg.ts`
- `packages/@openmaic/storage/src/runtime/types.ts`
- `tests/quiz/runtime.test.ts`
- `tests/runtime/chat-storage-core.test.ts`
- `tests/runtime/chat-storage.test.ts`
- `e2e/tests/playback-resume-cutover.spec.ts`
- `CHANGELOG.md` v0.3.2 段

### 2.6 审计过的本地文件

- `lib/runtime/outbox.ts`
- `lib/runtime/playback-outbox.ts`
- `lib/runtime/quiz-outbox.ts`
- `lib/runtime/shadow-writer.ts`
- `lib/utils/chat-storage.ts`
- `lib/utils/database.ts`
- `docs/reports/2026-08-02-runtimestore-r3-read-cutover-design.md`
- `docs/reports/2026-08-02-runtimestore-r2.1-a2-signed.md`
- `docs/reports/2026-08-02-runtimestore-r2.1-playback-a2-implementation.md`
- `docs/reports/2026-08-02-runtime-chat-idempotency-conflict.md`

### 2.7 未审计范围

- 上游 v0.3.2 中 AI 模型注册表、视频导出、i18n、agent transport 等非 RuntimeStore 变更；
- 上游服务端 Postgres 实现的完整索引/RPC 变更（仅审计 client-facing HTTP contract）；
- 本地 `components/edit/PlaybackChromeRoot.tsx` 与上游的 UI 差异（只审计持久化语义）；
- 本地 Chat UI `use-chat-sessions.ts` 逐行实现（只审计持久化/影子调用路径）。

---

## §3 RuntimeStore 能力矩阵

| 能力 | 上游 v0.3.2 | 本地 test/r3-line | 评估 |
|---|---|---|---|
| 可靠 outbox | ❌ Quiz/Playback 直接写 RuntimeStore，无持久化 outbox；Chat 写 RuntimeStore 但依赖 storeQueues + Web Locks 内存队列 | ✅ `lib/runtime/outbox.ts` R3.0 通用 outbox，Dexie 持久化 | 上游缺失本地 outbox 级离线恢复 |
| dependency chain | ❌ 无（Quiz 用 attemptId queue + retry id；Chat 用 generation） | ✅ `runtimeOutbox.dependsOnEntryId` + `runtimeChainHeads` | 本地更严格 |
| claim/lease | ❌ 上游 RuntimeStore 接口无 lease | ✅ `lib/runtime/outbox.ts:36` `LEASE_DURATION_MS=30000`；`dequeueOne` CAS 租约 | 本地覆盖 |
| CAS | ✅ `expectedLastSeq`（`storage/runtime/types.ts:67-73`） | ✅ outbox 内按 `dependsOnEntryId` 与 succeededEntries 校验 | 本地 CAS 在依赖链层面，上游 CAS 在 seq 层面 |
| retry/backoff | ⚠️ 上游无显式重试（store 直接抛错）；Quiz writer 有 debounce | ✅ `BACKOFF_SCHEDULE` 6 级指数退避（`lib/runtime/outbox.ts:27-34`） | 本地覆盖 |
| dead cascade | ❌ 上游无 dead 级联 | ✅ `cascadeMarkDeadInTx`（`lib/runtime/outbox.ts:88-105`） | 本地覆盖 |
| succeeded evidence | ✅ `succeededEntries` 等价物：上游直接读取 store | ✅ `lib/runtime/outbox.ts` 独立的 `succeededEntries` 表 | 本地有显式成功凭据表 |
| compaction | ⚠️ Chat generation rollover 替代 compaction | ✅ playback semanticKey superseded（`lib/runtime/outbox.ts:136-143`） | 不同策略 |
| refresh recovery | ✅ Quiz legacy migration；Playback KV cursor；Chat reload from RuntimeStore | ✅ Quiz envelope；Playback Dexie playbackState；Chat localStorage cursor | 本地 refresh 基于本地 store，上游基于 RuntimeStore |
| offline recovery | ❌ 无本地 outbox，离线即丢失写 | ✅ outbox 持久化 pending，恢复网络后 drain | 本地覆盖 |
| cross-tab behavior | ✅ Quiz `navigator.locks`；Chat partition lock | ✅ Dexie rw 事务 + leaseOwner | 都覆盖，机制不同 |
| idempotency | ✅ DSL validate + echoMatches；Chat record id 含 updatedAt | ✅ frozenBody + semanticKey + 409 IDEMPOTENCY_CONFLICT skip | 本地偏保守，上游偏精确 |
| Playback cycle identity | ❌ 上游无 cycle/visit 概念；cursor 为 device-scoped KV 可变状态 | ✅ R3.1a `persistSnapshotWithComplete` visit session（`lib/runtime/playback-visit.ts`） | 本地已签字 visit-session 语义更严格 |
| Quiz phase ordering | `draft < submitted < reviewed`（`lib/quiz/runtime.ts:93-97`） | `submitted → reviewed → completed → archived`（`lib/runtime/quiz-outbox.ts:127-132`） | **冲突**：上游无 `completed/archived`，且支持 draft |
| server read/cutover | ✅ 上游 Quiz/Playback/Chat 都已读 RuntimeStore | ❌ 本地只授权到 shadow，dual-read 未实施 | 上游领先但未经授权 |
| rollback behavior | ⚠️ 依赖 store 事务 | ✅ outbox dead 级联 + superseded | 本地覆盖 |

---

## §4 Quiz 差异

### 4.1 上游 Quiz 写入/读取/恢复模型

上游把 Quiz 完全迁移到 `RuntimeStore`：

- **身份**：`quizAttemptId(stageId, sceneId, learnerKey)`（`lib/quiz/runtime.ts:252-259`）。
- **写入**：`recordQuizAttempt` 直接调用 `store.createSession` / `store.appendRecord` / `store.setSessionStatus`（`lib/quiz/runtime.ts:463-635`）。
- **读取**：`loadQuizAttemptState` 通过 `store.listSessions` + `store.listRecords` 读取最新 `QuizAttemptPayload`（`lib/quiz/runtime.ts:261-284`）。
- **恢复**：支持 legacy localStorage snapshot 的一次性迁移（`migrateLegacyQuizState`，`lib/quiz/runtime.ts:286-365`）。

### 4.2 上游 Quiz 关键代码路径

```text
lib/quiz/runtime.ts:93-97      PHASE_ORDER = {draft:0, submitted:1, reviewed:2}
lib/quiz/runtime.ts:199-216     per-store + per-attemptId 内存队列（非持久化）
lib/quiz/runtime.ts:218-223     Web Locks API
lib/quiz/runtime.ts:463-635     recordQuizAttempt 主循环：创建/追加/rollover
lib/quiz/runtime.ts:425-431     rolloverAttemptId = `${attemptId}:retry:${index}`
```

### 4.3 上游 Quiz 状态机

- 支持 `draft` 阶段（debounce 写入）。
- `submitted` 阶段直接 append。
- `reviewed` 阶段通过 `sessionTransition: {status: 'completed'}` 原子完成会话（`lib/quiz/runtime.ts:602-606`）。
- 不支持本地定义的 `completed` 或 `archived` record/状态。
- completed 后若再写（`startNewAttempt=true`），会生成 `:retry:N` 新 session（`lib/quiz/runtime.ts:425-431`），**不是复用旧 session**。

### 4.4 本地 Quiz 状态机

- R3.2 设计：`create → submitted → reviewed → completed → archived`（`lib/runtime/quiz-outbox.ts:127-132`）。
- 严格依赖链：每个后续 outbox entry 的 `dependsOnEntryId` 指向前一个；通过 `runtimeChainHeads` 维护链尾（`lib/runtime/quiz-outbox.ts:44-51`）。
- 服务端 `completed` 后禁止追加 record（409 `INACTIVE_SESSION`），因此本地把 `completed` 放在 reviewed/grade 之后，archived 放在 completed 之后。

### 4.5 可移植的小补丁

| 上游能力 | 本地状态 | 是否建议移植 |
|---|---|---|
| `draft` 阶段快照 | 本地只写 submitted/reviewed | **REFERENCE_ONLY**：本地业务无 draft 持久化需求 |
| `startNewAttempt` rollover | 本地无（R3.2 单 attempt 周期） | **REFERENCE_ONLY**：retry 语义需单独设计卡 |
| Web Locks 跨标签页 | 本地依赖 Dexie 事务 | **REFERENCE_ONLY**：可吸收测试思路 |
| legacy migration | 本地已有 `readSubmittedEnvelope` | **ADAPT**：上游读取旧 snapshot 后写 RuntimeStore 的思路可参考，但需按 outbox 重写 |

### 4.6 冲突点

- 上游无 outbox，本地 R3.2 已签字使用 outbox。直接合入会**丢失离线恢复与严格顺序**。
- 上游 `reviewed` 即完成会话；本地 `reviewed` 后还需显式 `completed` 与 `archived`。服务端契约可能不同。

---

## §5 Playback 差异

### 5.1 上游 Playback 恢复模型

上游把 playback 的**恢复游标**从持久化存储中拆出为**设备级可变 KV 状态**：

- `lib/playback/cursor.ts`：cursor 存到 `BrowserKVStore` device scope，key = `playback-cursor:${stageId}`。
- `lib/playback/cursor.ts:102-136`：一次性 lazy migration，把 legacy Dexie `playbackState` 的 cursor 部分迁移到 KV。
- **明确声明**：`consumed-discussion state is volatile by decision`（`lib/playback/cursor.ts:97-100`），不持久化。

### 5.2 上游 Playback 关键代码路径

```text
lib/playback/cursor.ts:36-42      CURSOR_KEY_PREFIX
lib/playback/cursor.ts:63-69        loadCursorValue 校验
lib/playback/cursor.ts:102-136      migrateLegacyCursor（Dexie → KV）
e2e/tests/playback-resume-cutover.spec.ts:85-125  验证 cursor 跨页面存活
```

### 5.3 本地 Playback 恢复模型

- 本地仍使用 Dexie `playbackState` 行（`lib/utils/playback-persistence.ts`、`lib/runtime/playback-outbox.ts`）。
- R3.1a 已签字 visit-session 语义：completed 后重入采用**独立 cycle/visit session**（`lib/runtime/playback-visit.ts`，本地文件存在但本次审计未逐行展开）。
- 本地 pending 通过 `shadowPending` 字段与 outbox 结合，保证刷新/跨标签页恢复。

### 5.4 completed 后重入

- **上游**：cursor 是 device KV 可变状态，completed 后不清也可以重新 start；RuntimeStore records 仅作为 learner facts，不是恢复源。
- **本地**：R3.1a visit session 生成新 session id，completed 会话不可追加。

### 5.5 session identity

- 上游 playback 无显式 session identity；RuntimeStore session 按 `(stageId, learnerKey, kind='playback')` 列出。
- 本地：`pb:${stageId}` 单 session，eventId 决定 record id（`lib/runtime/playback-outbox.ts:115-127`）。

### 5.6 跨标签页行为

- 上游 cursor 是 device KV LWW，跨标签页可见。
- 本地 Dexie `playbackState` 行通过 rw 事务 + CAS，跨标签页一致。

### 5.7 评估

| 项 | 结论 |
|---|---|
| 整体引入上游 cursor/KV 模型 | **REJECT**：与本地 R2.1 A2 签字模型冲突 |
| 上游「consumed-discussion volatile」决策 | **REFERENCE_ONLY**：可作为设计讨论输入 |
| 上游 playback E2E 覆盖 | **REFERENCE_ONLY**：本地可补充类似跨页恢复 E2E |

---

## §6 Chat 差异

### 6.1 上游 Chat 持久化模型

上游把 Chat 从 Dexie 主存储彻底切换到 **RuntimeStore records**：

- `lib/utils/chat-storage.ts`：保存/加载都走 `RuntimeStore`；Dexie `chatSessions` 仅作为 legacy migration source。
- `lib/utils/chat-storage-core.ts`：
  - 每条消息一个 `chat_message` payload；
  - 每个会话状态一个 `chat_session_state` payload；
  - `foldRecords` 按 `message.id` 去重，以 `sessionUpdatedAt` / `seq` 决胜（`lib/utils/chat-storage-core.ts:381-432`）。
- `lib/utils/chat-storage.ts:111-117`、`238-271`：per-store + per-key 内存队列 `storeQueues` + Web Locks，串行化对同一 partition 的写入。

### 6.2 finalized-message 信号

上游**没有显式的 finalized-message 信号**。它通过以下机制近似：

- 每次保存时把当前消息完整快照写入 record，record id 包含 `session.updatedAt`（`lib/utils/chat-storage-core.ts:484-501`）。
- 同 `message.id` 多个 record 在 `foldRecords` 中按 `sessionUpdatedAt` 最大者取胜。
- 因此“最终消息”= 该 message id 下最新一次完整保存的快照。

本地调查报告（`docs/reports/2026-08-02-runtime-chat-idempotency-conflict.md`）明确指出：R3 前**缺少 finalized-message 信号**。上游方案用“多次写入+去重”替代了“单次 finalized 信号”，并未从根本上解决“何时可以安全持久化”的语义问题。

### 6.3 消息 ID 生成与稳定性

- 上游 record id：`${runtimeId}:message:${encodeURIComponent(message.id)}:${session.updatedAt}`（`tests/runtime/chat-storage-core.test.ts:120-122`）。
- message id 本身来自 ChatSession 创建时的 `session-${Date.now()}-${Math.random()}`（本地调查报告 §2.1）。
- **相同 message.id 在 payload 变化后会生成不同 record id**，因此上游不存在本地意义上的“同 ID 不同 payload”冲突。

### 6.4 payload 不可变性

- 上游消息 payload **不是不可变的**：同 message.id 可以有多条 record，内容不同，`foldRecords` 按时间/seq 取最新。
- 本地 R2 chat payload 裁剪为 `{role, content}`，且存在流式 content 漂移（本地调查报告 §3）。

### 6.5 并发保存串行化

上游使用两层锁：

1. `navigator.locks.request(chatStoragePartitionLockName)`（`lib/utils/chat-storage.ts:214-236`）跨标签页锁；
2. `storeQueues` 内存队列保证同 store 同 key 的写入串行（`lib/utils/chat-storage.ts:238-271`）。

测试 `tests/runtime/chat-storage.test.ts` 中有并发写入测试（如 `writes only changed records and ignores an older save that arrives later`）。

### 6.6 游标并发

上游没有本地意义上的“游标”。它通过读取 RuntimeStore 全部 records 并 fold 来恢复；写入时通过 `planChatSync` 计算增量，因此不存在多个 fire-and-forget 任务读取相同旧游标的问题。

### 6.7 legacy migration

- 上游 `fromLegacyRecords` 严格校验旧 Dexie row shape，跳过损坏行并记录 `skippedRows`（`lib/utils/chat-storage-core.ts:129-230`）。
- 修复越界时间戳（`legacyTimestamps`，`lib/utils/chat-storage-core.ts:161-180`）。

### 6.8 是否足以解除 Chat shadow-only 阻断

**不足够。**

理由：

1. 上游 Chat 已作为**正式读源**切换到 RuntimeStore，而本地 R3 v1.1 **明确禁止** chat 进入 dual-read 及之后阶段。
2. 上游没有 finalized-message 信号，只是用多次快照+去重掩盖了问题；本地 R3 v1.1 把 finalized-message 列为解除阻断前置条件（G3.1）。
3. 上游需要服务端/DSL 同时支持 chat kind 的读源切换；本地当前 shadow 阶段未验证 dual-read match 率。
4. 上游使用 `BrowserRuntimeStore`（IndexedDB 本地 RuntimeStore 实现）与 HTTP RuntimeStore；本地仍走 `/api/runtime/v1/*` shadow 路径，架构不同。

### 6.9 对本地 Chat 冲突窗口的启示

上游通过**唯一 record id（含 updatedAt）+ fold 去重**完全避开了“同 ID 不同 payload”冲突。本地若未来设计 Chat outbox，可借鉴：

- 不将 message.id 直接作为 record id；
- record id 包含版本戳（如 message.updatedAt / generation）；
- 服务端/读取侧按 message.id 折叠，取最新版本。

但此方案要求服务端支持同 id 多版本 records，与本地当前服务端幂等冲突检测（同 id 严格比 payload）不同，需要独立设计卡。

---

## §7 HTTP/Persistence 契约差异

### 7.1 契约差异表

| 操作 | 上游 v0.3.2 | 本地 test/r3-line | 分类 |
|---|---|---|---|
| **create session** | `POST /runtime/sessions`，body 为 `RuntimeSessionInit`，服务端 stamp `runtimeDslVersion`（`storage/runtime/types.ts:96-103`） | `POST /api/runtime/v1/sessions`，body 含完整 `id, kind, stageId, status, createdAt, updatedAt`（`lib/runtime/outbox.ts:77-78`） | LOCAL_DIFFERENT_BUT_STRICTER（本地带时间戳）/ CONFLICTS_WITH_LOCAL（路径不同） |
| **append record** | `POST /runtime/sessions/{id}/records`，支持 `expectedLastSeq` CAS 与 `sessionTransition`（`storage/runtime/types.ts:159-162`） | `POST /api/runtime/v1/sessions/{id}/records`，无 CAS（`lib/runtime/outbox.ts:79-80`） | MISSING_LOCALLY_ADOPT（可考虑移植 expectedLastSeq） |
| **set status** | `PATCH /runtime/sessions/{id}/status`，支持 `expectedLastSeq`（`storage/runtime/types.ts:135-140`） | `PATCH /api/runtime/v1/sessions/{id}/status`（`lib/runtime/outbox.ts:81-82`） | MISSING_LOCALLY_ADOPT |
| **get/read session** | `GET /runtime/sessions/{id}`，返回 `RuntimeSession`，客户端再次 `migrateRuntime` + `validateRuntimeSession`（`storage/runtime/http.ts:238-263`） | 服务端内部读取，客户端 outbox 不直接读 session | LOCAL_ALREADY_COVERED（服务端负责） |
| **list/read records** | `GET /runtime/sessions/{id}/records`；HTTP 层返回后 `response.json()`（`storage/runtime/http.ts`） | 服务端内部读取 | LOCAL_ALREADY_COVERED |
| **409 分类** | `RUNTIME_APPEND_CONFLICT` 结构化，含 `expectedLastSeq`/`actualLastSeq`（`storage/runtime/http.ts:208-227`） | 本地解析 `errorCode` 字符串，已知 `IDEMPOTENCY_CONFLICT`、`INACTIVE_SESSION`（`lib/runtime/outbox.ts:108-114`、`lib/runtime/shadow-writer.ts:205-222`） | MISSING_LOCALLY_ADOPT（若需自动对齐 seq） |
| **404 行为** | `SESSION_NOT_FOUND` code，HTTP 层转换为 `undefined`（`storage/runtime/http.ts:251-263`） | 本地 Chat 404 清 created 标记（`lib/runtime/shadow-writer.ts:395-397`） | LOCAL_ALREADY_COVERED |
| **二进制 vs JSON 响应** | HTTP 层明确 `response.json()` 或 `response.status === 204`（`storage/runtime/http.ts:230-231`） | 本地 shadow-writer 仅处理 JSON | LOCAL_ALREADY_COVERED |
| **身份注入** | `headers` hook：`HttpRuntimeHeadersHook`（`storage/runtime/http.ts:23-25`） | 本地通过 Next.js API route 自动带 cookie/session | LOCAL_DIFFERENT_BUT_STRICTER |
| **幂等冲突返回结构** | 结构化 `{error: {code, message, details}}`（`storage/runtime/http.ts:36-48`） | 本地服务端返回 `{errorCode}`（`lib/runtime/outbox.ts:111-112`） | CONFLICTS_WITH_LOCAL |
| **空字段/undefined 序列化** | 明确删除 `OPTIONAL_RECORD_ANCHORS` 中的 `undefined`（`storage/runtime/http.ts:76-93`） | 本地用 `JSON.parse(JSON.stringify(body))` 删除所有 undefined（`lib/runtime/outbox.ts:55-57`） | LOCAL_DIFFERENT_BUT_STRICTER |
| **fetch 绑定** | 显式 `selectedFetch.bind(globalThis)`（`storage/runtime/http.ts:159-175`） | 本地未使用 `@openmaic/storage` package，直接调用 `fetch` | LOCAL_ALREADY_COVERED（当前无风险）/ MISSING_LOCALLY_ADOPT（若引入 package） |
| **Runtime record 校验** | 写边界 `validateRuntimeRecord`（`storage/runtime/http.ts:105-128`） | 本地 outbox 入队前仅 `JSON.stringify` | MISSING_LOCALLY_ADOPT |
| **Runtime session 校验** | 写边界 `validateRuntimeSession` + 读边界再次 `assertValidSession`（`storage/runtime/http.ts:95-103`、`238-240`） | 服务端负责 | MISSING_LOCALLY_ADOPT |

### 7.2 Browser/Postgres RuntimeStore 行为变化

- `packages/@openmaic/storage/src/runtime/browser.ts` 实现 IndexedDB 版的 `RuntimeStore`；
- `packages/@openmaic/storage/src/runtime/pg.ts` 实现 Postgres 版；
- 本地当前未使用这两个实现，而是直接调用 `/api/runtime/v1/*`。若未来使用，需要单独审计 Browser/Postgres 的 seq 分配、迁移、错误分类。

---

## §8 候选移植清单

| # | 上游 commit/PR | 涉及文件 | 解决的问题 | 本地覆盖 | 冲突风险 | 建议动作 | 所需测试 | 是否独立设计卡 |
|---|---|---|---|---|---|---|---|---|
| 1 | `ad30061b` #1050 | `packages/@openmaic/storage/src/runtime/http.ts:159-175` | fetch 未绑定导致 `Illegal invocation` | 当前未用该 package，无风险；若引入则有风险 | 低 | **ADOPT_NOW**：若引入 `@openmaic/storage` 必须同步引入此修复 | package 集成测试 | 否 |
| 2 | `ad30061b` #1050 | `packages/@openmaic/storage/src/runtime/http.ts:76-93` | undefined 字段序列化 | 本地 `freezeBody` 已删除 undefined | 中 | **REFERENCE_ONLY** | 已有 outbox 测试 | 否 |
| 3 | `ad30061b` #1050 | `packages/@openmaic/storage/src/runtime/http.ts:95-128`、`types.ts` | Runtime record/session 写边界校验 | 本地无 | 中 | **ADAPT**：在 outbox 入队前增加 DSL 校验；需按本地 outbox 重写 | 新增 `runtime-outbox/validation` 测试 | 是 |
| 4 | `ad30061b` #1050 | `packages/@openmaic/storage/src/runtime/http.ts:208-227` | 409 结构化冲突详情 | 本地只解析 errorCode | 中 | **ADAPT**：服务端/客户端协商统一 error schema 后引入 | 409 conflict 集成测试 | 是 |
| 5 | `3eea9dc5` #955 | `lib/quiz/runtime.ts` | Quiz RuntimeStore 化 | 本地已有 outbox 模型 | **高** | **REJECT**：与 R3.2 outbox 签字冲突 | — | 否 |
| 6 | `3eea9dc5` #955 | `lib/playback/cursor.ts` | Playback cursor KV 化 | 本地 Dexie playbackState | **高** | **REJECT**：破坏 R2.1 A2 签字 | — | 否 |
| 7 | `3eea9dc5` #955 | `lib/quiz/runtime.ts:199-216`、`218-223` | Quiz 内存队列 + Web Locks | 本地 Dexie 事务 | 中 | **REFERENCE_ONLY**：可吸收测试思路 | 本地 outbox 跨标签页测试 | 否 |
| 8 | `ad30061b` #1050 | `lib/utils/chat-storage-core.ts`、`chat-storage.ts` | Chat RuntimeStore 读源切换 | 本地 shadow-only | **高** | **REJECT**：违反 R3 v1.1 chat 红线 | — | 否 |
| 9 | `ad30061b` #1050 | `lib/utils/chat-storage-core.ts:381-432` | 同 message.id 多版本 fold 去重 | 本地无 | 中 | **REFERENCE_ONLY**：未来 Chat outbox 设计参考 | 设计阶段 prototype | 是 |

---

## §9 风险与红线

### 9.1 为什么不能整体 merge/cherry-pick

1. **架构分叉**：本地以 **outbox + 依赖链 + succeededEntries** 为核心；上游以 **RuntimeStore 直接读写 + 内存队列** 为核心。两者互斥。
2. **签字状态机冲突**：本地 R3 v1.1 五阶段（local-only → shadow → dual-read-compare → server-preferred → server-primary）与上游「Quiz/Playback/Chat 已 RuntimeStore 化」直接冲突。
3. **Chat 红线**：上游 Chat 已是正式读源；本地明确禁止 chat dual-read。
4. **Quiz 阶段冲突**：上游 phase order `draft < submitted < reviewed`，本地 `submitted → reviewed → completed → archived`。
5. **数据模型冲突**：本地 playback 使用 Dexie `playbackState` 行与 visit-session；上游使用 device KV cursor。

### 9.2 最可能破坏的本地不变量

- `runtimeOutbox` 的严格依赖链与 dead 级联；
- `runtimeChainHeads` 维护的 Quiz 链尾语义；
- `playbackState` 行的 `shadowPending` + eventId + capturedAt 不可变语义；
- Chat shadow-only 红线；
- 服务端控制面作为阶段切换唯一权威。

---

## §10 后续任务拆分建议

### 卡 1：移植 HTTP RuntimeStore 基础修复（低冲突）

- **目标**：评估并可选地引入上游 `ad30061b` 中 fetch 绑定、undefined 字段处理、record/session 校验等不破坏本地架构的修复。
- **范围**：
  - 若本地引入 `@openmaic/storage` package，则必须引入 fetch 绑定；
  - 在 outbox 入队/发送路径增加 `validateRuntimeRecord`/`validateRuntimeSession` 可选校验；
  - 不改动 Quiz/Playback/Chat 业务代码。
- **明确不做**：不改变读源、不引入 Chat RuntimeStore 化、不实施 dual-read。
- **验收门禁**：新增/现有 outbox 单元测试全绿；tsc 无新增错误。
- **是否影响 Production**：否（仅增加校验与防御性绑定）。
- **是否需要单独授权**：否（纯本地防御性增强）。

### 卡 2：409 RUNTIME_APPEND_CONFLICT 结构化错误适配（中冲突）

- **目标**：在本地 outbox 中解析并利用 `expectedLastSeq`/`actualLastSeq` 做自动对齐或重试决策。
- **范围**：
  - 服务端返回结构化 409 详情；
  - 客户端 outbox 在 `extractErrorCode` 基础上扩展解析；
  - 仅用于 playback/quizAttempt（Chat 不进入 dual-read）。
- **明确不做**：不改变当前 409 IDEMPOTENCY_CONFLICT skip 行为；不用于 Chat。
- **验收门禁**：新增 409 冲突解析与对齐测试；shadow 遥测不变形。
- **是否影响 Production**：否（ shadow-only 阶段可记录遥测，不切换读源）。
- **是否需要单独授权**：是（涉及服务端错误 schema 变更）。

### 卡 3：吸收上游 Quiz/Playback/Chat 测试用例到本地 outbox（中冲突）

- **目标**：把上游 PR #955/#1050 中覆盖本地尚未覆盖的并发、跨标签页、legacy migration 场景，转化为本地 outbox 测试。
- **范围**：
  - Quiz outbox 跨标签页/重复提交/离线恢复测试；
  - Playback outbox completed 后重入、跨页恢复测试；
  - Chat shadow 并发窗口测试（基于本地调查报告）。
- **明确不做**：不引入上游 RuntimeStore 直接读写实现。
- **验收门禁**：新增测试通过；不降低现有覆盖率。
- **是否影响 Production**：否（只加测试）。
- **是否需要单独授权**：否。

### 卡 4：Chat 持久化 outbox / finalized-message 独立设计（高冲突、高价值）

- **目标**：基于上游 generation/fold 思路与本地 R3 v1.1 红线，设计 Chat 专用持久化 outbox 或 finalized-message 信号。
- **范围**：
  - 明确 finalized-message 信号定义（流式结束/ action 就绪）；
  - 设计 Chat outbox schema、record id 策略、fold/去重策略；
  - 论证是否复用 `runtimeOutbox` 或新建 `chatOutbox`。
- **明确不做**：不实施 dual-read；不切换读源；不修改 Chat UI 状态机。
- **验收门禁**：设计文档通过 Codex 评审；包含至少 3 个并发/离线/跨标签页测试方案。
- **是否影响 Production**：否。
- **是否需要单独授权**：是（涉及 R3 chat 红线解除）。

---

## §11 证据附录

### A. 上游关键文件与行号

- `packages/@openmaic/storage/src/runtime/http.ts:159-175` — fetch 显式绑定
- `packages/@openmaic/storage/src/runtime/http.ts:76-93` — 删除 optional record anchors 中的 undefined
- `packages/@openmaic/storage/src/runtime/http.ts:95-128` — Runtime record/session 写边界校验
- `packages/@openmaic/storage/src/runtime/http.ts:208-227` — 409 `RUNTIME_APPEND_CONFLICT` 结构化错误
- `packages/@openmaic/storage/src/runtime/types.ts:96-162` — RuntimeStore 接口契约
- `lib/quiz/runtime.ts:93-97` — Quiz phase order
- `lib/quiz/runtime.ts:199-216` — per-attempt 内存队列
- `lib/quiz/runtime.ts:425-431` — `:retry:N` rollover
- `lib/quiz/runtime.ts:463-635` — `recordQuizAttempt` 主循环
- `lib/playback/cursor.ts:36-42` / `102-136` — device KV cursor + legacy migration
- `lib/utils/chat-storage-core.ts:381-432` — foldRecords 去重
- `lib/utils/chat-storage-core.ts:484-501` — buildChatRecordInit（record id 含 updatedAt）
- `lib/utils/chat-storage.ts:214-271` — Web Locks + storeQueues 串行化

### B. 上游测试证据

- `tests/runtime/chat-storage-core.test.ts:111-130` — `buildChatRecordInit` record id 构造
- `tests/runtime/chat-storage-core.test.ts:169-179` — completed destination 触发 `start-generation`
- `tests/runtime/chat-storage.test.ts:159-189` — chat 作为 RuntimeStore records 持久化并读回
- `tests/runtime/chat-storage.test.ts:256-274` — 只写 changed records、忽略旧保存
- `tests/quiz/runtime.test.ts:57-79` — draft debounce
- `tests/quiz/runtime.test.ts:81-108` — submitted 前 flush draft
- `tests/quiz/runtime.test.ts:110-165` — 读取等待 writer tail
- `e2e/tests/playback-resume-cutover.spec.ts:85-125` — playback cursor 跨页存活

### C. 本地关键文件与行号

- `lib/runtime/outbox.ts:17-39` — outbox phase、op、kind、backoff、lease 常量
- `lib/runtime/outbox.ts:88-105` — dead 级联
- `lib/runtime/outbox.ts:118-157` — enqueue 与 playback compaction
- `lib/runtime/outbox.ts:169-201` — dequeueOne claim/lease/CAS
- `lib/runtime/quiz-outbox.ts:127-132` — Quiz 状态机注释
- `lib/runtime/quiz-outbox.ts:44-51` — runtimeChainHeads 链尾
- `lib/runtime/playback-outbox.ts:115-153` — playback outbox 入队
- `lib/runtime/shadow-writer.ts:134-154` — Chat cursor localStorage
- `lib/runtime/shadow-writer.ts:348-432` — shadowOneChatSession（含 IDEMPOTENCY_CONFLICT skip）
- `lib/utils/chat-storage.ts:22-57` — 本地 Chat 仍保存到 Dexie，fire-and-forget shadow

### D. 本地签字文档章节

- `docs/reports/2026-08-02-runtimestore-r3-read-cutover-design.md` 第一章 1.3、第二章 2.1、第九章 §9.2
- `docs/reports/2026-08-02-runtimestore-r2.1-a2-signed.md` 验收结论、§3、§4
- `docs/reports/2026-08-02-runtime-chat-idempotency-conflict.md` §1、§2、§3、§4

---

## §12 完成自查

- [x] 工作树初始状态干净
- [x] 从 `test/r3-line` HEAD `4579519b` 创建审计分支 `chore/openmaic-v032-runtime-audit`
- [x] 未修改产品代码
- [x] 未执行 SQL
- [x] 未修改环境变量
- [x] 未部署
- [x] 未清理生产/Preview 数据
- [x] 未实施 dual-read
- [x] 未改变 Chat/Playback/Quiz 当前开关
- [x] 报告中引用的上游 commit/PR 已验证存在
- [x] 报告中引用的本地文件路径已验证存在
