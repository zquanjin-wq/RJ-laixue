# R3 RuntimeStore 读源切换总设计稿 v1.1

- 日期：2026-08-02（v1）；2026-08-02（v1.1 修订）；2026-08-02（v1.1 第二轮修订）
- 起草人：架构师（rj-laixue-architect）→ 第二轮修订：团长（Kimi）
- 状态：v1.1（第二轮修订版，关闭 6 项实施级阻断点；待 Codex/负责人复审签字）
- v1.1 变更摘要：8 项开放决策已拍板（D1-D8）；8 个阻断点已关闭；3 处额外修正；6 项实施级阻断点已关闭
- 前置：R1.1 SIGNED、R2 SIGNED、R2.1 A2 SIGNED、chat idempotency_conflict 调查报告（含勘误 B）
- 施工目录：`D:\WorkBuddy 地界\RJ-laixue-storage-b2`
- 分支：`test/r3-line`

---

## 摘要与整体策略

### 当前状态

R2/R2.1 已完成三种负载（chat、quizAttempt、playback）的影子写（shadow write），本地读源不变。Preview 环境两条 shadow 开关均为 `1`，遥测正在积累。

R3 的目标是**把服务端 RuntimeStore 从"只写不看"的镜像升级为正式读源**——即在确认服务端数据完整性、排序正确性、离线恢复能力均达标后，逐步将客户端读取路径从 IndexedDB/localStorage 切换到服务端 HTTP API。

### 整体策略：分 kind、分阶段、chat 独立阻断

**核心原则**：三种负载的数据模型、写入语义、完整性约束差异巨大，不能一刀切切换。R3 采用"分 kind 推进"策略：

| kind | R3 可进入阶段 | 阻断项 | 推进策略 |
|------|:----------:|--------|---------|
| **playback** | shadow → dual-read（v1.1 授权上限；server-preferred/server-primary 推迟） | 无阻断 | 按阶段门禁逐级通过 |
| **quizAttempt** | shadow → dual-read（v1.1 授权上限；server-preferred/server-primary 推迟） | 无阻断 | 按阶段门禁逐级通过 |
| **chat** | **仅 shadow（不得进入 dual-read 及之后）** | finalized-message 信号 / 持久化 outbox 缺失 | **独立阻断分支**，另立 outbox 子设计 |

**chat 阻断说明（详见第十三章专章）**：

- R2 chat payload 裁剪为 `{role, content}` 且部分写入为 partial 内容——不够作为正式读源；
- chat 缺少 finalized-message 信号（消息何时稳定）；
- chat 缺少持久化不可变 outbox（当前游标在 localStorage，跨标签页不安全）；
- 勘误 B.5 明确裁定：**chat 不得进入 server-preferred/server-primary**，直至 finalized-message 或持久化 outbox 方案落地并已验证。

### R2/R2.1 不可重开决策清单

以下决策已签字锁定，R3 设计不得推翻：

1. chat payload 只含 `{role, content}`（R2）；R3 前不作为正式读源；
2. quizAttempt 单键 envelope 原子写（R2）；
3. 影子路径身份/答案从持久化状态读回（R2）；
4. 匿名期不影子写；access code 不能作分区键（R2）；
5. 409 `IDEMPOTENCY_CONFLICT` shadow 阶段不重试但遥测（R2）；
6. playback 事务内 UUID + 冻结内容 + 条件清除（R2.1 A2）；
7. playback 最新快照按 capturedAt，同时间按 eventId 字典序 tie-break（R2.1 A2）；
8. completed PATCH 失败保留 pending 补偿（R2.1 A2）；
9. superseded 标记 `source: local_drop`（R2.1 A2）；
10. playback 双开关门禁（R2.1 A2）。

---

## 第一章：按 kind 切读门禁

### 1.1 playback

#### 当前状态

- 本地持久化：Dexie `playbackState` 单行（per stageId），事务内 UUID + 冻结内容；
- 影子写：`shadowPlaybackProgress`，幂等状态机四态（A/B/C/D），pending 条件清除；
- Preview E2E：201 写入正确，capturedAt 一致，pending 清除正常；
- 数据模型：单行最新快照，每次落盘覆盖前值。

#### 完整性门禁

| 门禁项 | 当前状态 | R3 需要 |
|--------|---------|---------|
| record ID 确定性 | ✅ eventId 事务内生成，重试/刷新取回同一值 | 无需额外工作 |
| 内容不可变性 | ✅ Dexie 行冻结后不漂移 | 无需额外工作 |
| 排序确定性 | ✅ capturedAt（ms 精度）+ eventId 字典序 tie-break | 需确认服务端 `/records/latest` 使用相同排序规则（非 max seq，见第五章） |
| 恢复语义 | ✅ sceneId 定位 + actionIndex 钳制 | dual-read 阶段需比对本地恢复位置与服务端最新 record |
| 跨标签页安全 | ✅ Dexie rw 事务 + CAS + 条件清除 | 无需额外工作 |

#### 切读门禁清单（playback）

- [ ] G1.1：dual-read 阶段 ≥100 条 playback records 的本地 vs 服务端比对，match 率 ≥99%
- [ ] G1.2：跨标签页/跨设备恢复：服务端按 capturedAt + eventId 字典序取最新 record，其 sceneId + actionIndex 与本地恢复结果一致
- [ ] G1.3：completed 状态：服务端 session status 与本地 completed 语义对齐
- [ ] G1.4：离线后上线：pending 记录在恢复网络后成功发送，无丢失无重复

### 1.2 quizAttempt

#### 当前状态

- 本地持久化：localStorage 单键 envelope（`quizAnswers:<sceneId>`），原子写入；
- 影子写：`shadowQuizSubmitted` / `shadowQuizReviewed` / `shadowQuizRetry`，从 envelope 读回；
- 数据模型：单次答题周期一个会话，两条 record（submit + grade）；
- 幂等锚点：`<sessionId>:submit` / `<sessionId>:grade`，envelope 不可变。

#### 完整性门禁

| 门禁项 | 当前状态 | R3 需要 |
|--------|---------|---------|
| record ID 确定性 | ✅ `<sessionId>:submit` / `:grade`，envelope 稳定 | 无需额外工作 |
| 内容不可变性 | ✅ envelope 原子写入后内容冻结 | 无需额外工作 |
| 排序确定性 | ✅ submit → grade 顺序由业务保证 | 需确认服务端 seq 排序与业务顺序一致 |
| 恢复语义 | ✅ envelope 持久化，刷新后仍可读回 | dual-read 阶段需比对 |

#### 切读门禁清单（quizAttempt）

- [ ] G2.1：dual-read 阶段 ≥50 条 quizAttempt records 比对，match 率 ≥99%
- [ ] G2.2：retry/archive 语义：本地 archive 后服务端 session status = 'archived'
- [ ] G2.3：跨标签页：同一 sceneId 的 envelope 在标签页间一致；明确业务语义——同一 sceneId 两个标签页 last-write-wins，last-write-wins 场景需有竞争测试覆盖，不直接断言"不会重复提交"

### 1.3 chat — 独立阻断分支

**chat 不得进入 dual-read compare 及之后的任何阶段。** 阻断原因详见第十三章。

- [ ] G3.1（阻断解除前置）：finalized-message 信号确定，消息在流式结束 + action 就绪后标记稳定
- [ ] G3.2（阻断解除前置）：持久化不可变 outbox 就位，替代 localStorage 游标
- [ ] G3.3（阻断解除前置）：chat payload 字段清单重新评审（见第八章）
- [ ] G3.4（解除后）：≥200 条 chat records dual-read 比对，match 率 ≥99%

---

## 第二章：阶段状态机

### 2.1 五阶段定义

```
local-only ──→ shadow ──→ dual-read-compare ──→ server-preferred ──→ server-primary
```

| 阶段 | 读源 | 写目标 | 进入条件 | 退出条件 |
|------|------|--------|---------|---------|
| **local-only** | IndexedDB/localStorage | IndexedDB/localStorage | 初始状态 | 开关 + 门禁通过 → shadow |
| **shadow** | IndexedDB/localStorage | 本地 + 服务端（fire-and-forget） | R2/R2.1 已就位 | 遥测 ok 率达标 + 门禁通过 → dual-read |
| **dual-read-compare** | **双读**：本地主读 + 服务端比对读 | 本地 + 服务端 | shadow ok 率高 + 数据完整性门禁 | match 率达标 + SLO 达标 → server-preferred |
| **server-preferred** | 服务端主读，本地兜底 | 本地 + 服务端 | dual-read match 率 ≥99% + 离线恢复验证 | 连续 N 天 server-preferred 无降级 → server-primary |
| **server-primary** | 服务端唯一读源 | 服务端主写 + 本地缓存兜底 | ⏸ **推迟**（总设计稿定义方向，详细缓存契约在独立子设计卡中定义） | — |

**v1.1 授权范围**：当前总设计稿**只授权推进到 dual-read**。server-preferred 和 server-primary 在各自的子设计卡和缓存门禁签字前不得实施。server-primary 的以下缓存契约需在子设计卡中定义（不在本文档内）：
- 缓存 TTL 和过期策略；
- 最后成功同步版本号；
- 离线缓存过期后的 UI 行为（是否显示过期数据、如何提示用户）；
- 本地数据比服务端更新时是否允许显示（stale-while-revalidate）；
- 恢复联网后如何重新对账（diff/merge 策略）。

### 2.2 每阶段进出条件详解

#### shadow → dual-read-compare

**进入条件（per kind）**：

| kind | 条件 |
|------|------|
| playback | shadow ok 率 ≥95%，持续 ≥48h；pending age P95 < 60s；无未解决的 409 |
| quizAttempt | shadow ok 率 ≥95%，持续 ≥48h |
| chat | **不进入**（阻断） |

**退出条件（per kind）**：进入 dual-read-compare 即视为从 shadow 退出。

**开关设计**：

保留现有编译期 kill switch 作为紧急总保险，不新增任何 `NEXT_PUBLIC_*` 用于阶段控制：

```
NEXT_PUBLIC_RUNTIME_SHADOW=1           # 现有，控制 shadow 写（保留，编译期 kill switch）
NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK=1  # 现有，playback 子开关（保留，编译期 kill switch）
```

阶段推进不再由客户端 `NEXT_PUBLIC_*` 自行决定，改为**服务端权威配置下发**（详见第九章 §9.2）。客户端仅在 localStorage 缓存服务端下发的 per-kind 阶段配置，过期后重新拉取。紧急回退由服务端配置即时生效，无需无缓存 Redeploy。

#### dual-read-compare → server-preferred

**进入条件（per kind）**：

| kind | 条件 |
|------|------|
| playback | dual-read match 率 ≥99%（样本 ≥500 条）；missing 率 <1%；mismatch 均人工归因并关闭 |
| quizAttempt | dual-read match 率 ≥99%（样本 ≥200 条）；missing 率 <1% |
| chat | **不进入** |

**退出条件**：进入 server-preferred 即视为从 dual-read 退出。

**回退条件**：match 率跌破 95% 或 missing 率 >5% → 遥测上报警告，负责人手动回退到 dual-read（详见第九章）；当前不实施自动回退。

#### server-preferred → server-primary

**进入条件（per kind）**：

| kind | 条件 |
|------|------|
| playback | server-preferred 连续运行 ≥7 天；无负责人手动降级事件；SLO 全部绿灯 |
| quizAttempt | server-preferred 连续运行 ≥7 天；无负责人手动降级事件 |
| chat | **不进入** |

**退出条件（回退）**：服务端连续不可达 >30s 或读错误率 >10% → 降级到 server-preferred，再持续 >5min → 降级到 dual-read。

### 2.3 状态持久化与可观测

- 阶段控制由**服务端权威配置**下发（见第九章 §9.2），客户端通过 API 拉取 per-kind 阶段，缓存在 `localStorage`（`r3:phase:<kind>`），过期后重新拉取；
- 客户端**不得自行决定阶段**，localStorage 中的阶段值仅为服务端配置的缓存副本；
- 紧急回退：服务端配置修改后即时生效，客户端下次读操作或定期轮询（≤60s）时拉取新配置；
- 每次读操作上报 `runtime_dual_read` 遥测（本地值、服务端值、是否 match、耗时）；
- 阶段切换需在遥测中有明确 `phase_transition` 事件。

---

## 第三章：通用 outbox

### 3.1 为什么需要通用 outbox

当前三种负载的影子写缺乏统一的失败重试和离线排队机制：

| kind | 当前失败处理 | 问题 |
|------|------------|------|
| chat | 游标不前进，下次保存重试 | 游标在 localStorage，跨标签页不安全；partial 内容永久卡住 |
| quizAttempt | fire-and-forget，失败即丢弃 | 无重试，无离线排队 |
| playback | Dexie pending + 条件清除 | ✅ 最完善，但仅限 playback |

R3 dual-read 和 server-preferred 阶段要求服务端数据尽可能完整——丢失的影子写会直接变成 dual-read 的 missing。因此需要一个通用 outbox 来统一管理"待发送到服务端的 record"。

### 3.2 设计原则

1. **以 playback pending 为核心参照，但不是默认答案**——playback 的"单行最新快照"模型适用于不断覆盖的进度数据，不能直接套给追加型的 chat；
2. **chat 需要独立的 finalized-message outbox**（见第十三章）；
3. **outbox 必须持久化**（IndexedDB，非 localStorage），跨标签页安全；
4. **outbox 条目一旦冻结内容，不可原地修改**——如需更新内容，生成新的 outbox 条目。

### 3.3 表设计

**新建 Dexie 表 `runtimeOutbox`**（在 `lib/utils/database.ts` 中扩展）：

```typescript
interface RuntimeOutboxEntry {
  id: string;            // UUID，客户端生成，outbox 的主键
  kind: 'playback' | 'quizAttempt' | 'chat';  // chat 预留
  op: 'create_session' | 'append_record' | 'set_status';
  sessionId: string;
  recordId?: string;     // append_record 时填写
  semanticKey: string;   // 语义键，用于压缩和去重（如 "playback:<stageId>:latest-progress"）
  body: unknown;         // 冻结的请求 body（JSON 可序列化）
  createdAt: string;     // ISO，入队时间
  attempts: number;      // 已尝试次数
  nextAttemptAt: string; // ISO，下次可发送时间（控制重试退避）
  lastAttemptAt?: string;
  lastError?: string;
  leaseOwner?: string;   // 当前持有租约的标签页 ID（如 "tab:<uuid>"），NULL 表示未租赁
  leaseUntil?: string;   // ISO，租约到期时间
  status: 'pending' | 'sending' | 'superseded' | 'dead';
  sequence?: number;     // per-session 自增序号，用于依赖排序
  dependsOnEntryId?: string;  // 不可变的前置条目 id（UUID），不是 semanticKey。发送前必须确认该 id 对应的条目已成功
}
```

**辅助表 `succeeded_entries`**（成功凭据，解决"不存在≠成功"问题）：

```typescript
interface SucceededEntry {
  entryId: string;       // 已成功发送并删除的 outbox 条目 id
  deletedAt: string;     // ISO，删除时间
}
```

- 条目成功发送并从 outbox 删除时，在同一事务中写入 `succeeded_entries`；
- 保留 7 天（与 dead 清理周期一致）；
- 依赖检查时**不得单凭"前置条目不在 outbox"推断成功**——必须查询 `succeeded_entries` 确认真实成功凭据。
```

**索引**：`kind`, `status`, `createdAt`, `semanticKey`, `[kind+status]`, `[sessionId+sequence]`。

**字段说明**：

| 字段 | 用途 |
|------|------|
| `semanticKey` | 语义去重键。playback 压缩用 `playback:<stageId>:latest-progress`；quizAttempt 按业务相位区分：`qa:<sessionId>:submitted` / `qa:<sessionId>:reviewed` / `qa:<sessionId>:status:archived`（不可共用同一键）；chat 用 `chat:<sessionId>:<messageId>` |
| `nextAttemptAt` | 退避控制：失败后按指数退避设置下次可发送时间；出队时只取 `<= now` 的条目 |
| `leaseOwner` / `leaseUntil` | 跨标签页租约：发送前 claim 租约（写入 tabId + 30s），发送完成后条件确认 → 成功删、失败释放；刷新只回收已过期 lease |
| `sequence` / `dependsOnEntryId` | 依赖链：`dependsOnEntryId` 是不可变的前置条目 UUID（非 semanticKey）。create 成功后才能 append；append 全部完成后才能 set_status；依赖成功通过 `succeeded_entries` 凭据验证，不靠"条目不存在"推断 |

### 3.4 队列语义

#### 入队（enqueue）

- 调用方构造 record body 后，生成 UUID，写入 outbox 行（`status: 'pending'`）；
- **内容必须在入队前冻结**——入队后不得修改 body；
- 自动分配 `sequence`（per-session 自增）和 `semanticKey`；
- 若 `dependsOnEntryId` 指定了前置条目，写入对应不可变 entry ID。

**压缩（入队时执行）**：

- 入队时检查同 `semanticKey` 的已有 `pending` 条目；
- 压缩**只能覆盖未发送的进度快照**：`status='superseded'`、`status='dead'` 和已 claim（有 `leaseOwner`）的条目**不得**被 supersede；
- 对于 playback：新条目入队时，匹配 `semanticKey = "playback:<stageId>:latest-progress"` 的旧 `pending`（且未被 claim）→ 旧条目标记 `superseded`，新条目写入；
- 对于非覆盖型数据（quiz 的 submit/grade，chat）：semanticKey 不重复，不触发压缩；
- 压缩遥测：`outbox_compaction { superseded: N }`。

**依赖链规则**（`dependsOnEntryId` 指向不可变条目 UUID）：

| 依赖 | 规则 |
|------|------|
| `create_session` → `append_record` | append 的 `dependsOnEntryId` 指向 create 的 `id`（UUID）；create 成功并写入 `succeeded_entries` 后，append 的依赖才满足 |
| `append_record` → 下一条 `append_record` | 同 session 的 append 形成严格序列链：每条 append 的 `dependsOnEntryId` 指向前一条 append 的 `id` |
| 最后一条 `append_record` → `set_status` | status 的 `dependsOnEntryId` 指向最后一条 append 的 `id`；全部 append 成功（在 `succeeded_entries` 中有凭据）后才能发送 status |
| quiz `submitted` → `reviewed` | reviewed 的 `dependsOnEntryId` 指向 submitted 的 `id` |
| 服务端返回 404（session missing） | 重新入队 `create_session`（生成**新 UUID**），新 create 的 `id` 与旧 create 不同，旧依赖链不会串线；被 404 的那条 append 标记 dead，其 `dependsOnEntryId` 指向的仍是旧 create 的 id（旧 create 在 `succeeded_entries` 中已有凭据），级联逻辑自行处理 |
| 前置条目 dead | **递归级联**（见下方 dead 级联规则） |

**dead 级联规则（递归，不是仅直接依赖者）**：

标记条目 X 为 `dead` 时，在同一 Dexie rw 事务内执行：
1. 找到所有 `dependsOnEntryId = X.id` 的条目 → 标记 `dead`；
2. 对每个新标记 dead 的条目，**递归**执行步骤 1（即处理 A→B→C 全链，不止一层）；
3. 所有级联完成后才提交事务；
4. 上报遥测 `outbox_dependency_dead { rootEntryId, cascadedCount }`。

**dead 清理约束**：dead 条目 7 天后清理时，必须先确认**不存在任何 `dependsOnEntryId` 指向该条目的 pending/sending 条目**（级联 dead 已保证这一点），且对应的 `succeeded_entries` 凭据已超过 7 天保留期。

**per-session 并发约束**：同一 session 的所有条目共享同一个依赖链（严格 `sequence` 排序）。**多个标签页不能同时 claim 同一 session 的不同 sequence**——出队时每条条目单独即时 claim，claim 成功后该 session 的所有后续条目自然阻塞在 claim 步骤（lease 已被持有），直到当前条目发送完成并删除（dependency fulfilled）。这确保同一 session 在任何时刻最多只有一条条目在发送中。

#### 出队发送（dequeue & send）

**出队采用逐条即时 claim 模式，不批量预占**：

出队循环（每次迭代在一个 Dexie rw 事务内完成）：

1. **筛选可发送条目**：`status='pending'` AND `nextAttemptAt <= now()`；
2. **按 semanticKey 去重**：同 `semanticKey` 只保留 `createdAt` 最新的一条；
3. **依赖检查（使用成功凭据，不靠"不存在"推断）**：若条目有 `dependsOnEntryId`：
   - 在 outbox 中查找 `id` = `dependsOnEntryId` 的条目——若存在且 `status=dead` → 级联标记本条目 dead（递归），跳过；
     若存在且非 dead → 跳过（前置尚未完成）；
   - 若不在 outbox 中 → 查询 `succeeded_entries` 表——若找到凭据 → 依赖满足，继续发送；
     若找不到 → 异常（前置不明消失），标记 dead + 上报遥测 `outbox_dependency_lost`；
4. **即时 claim 一条**：对第一个符合条件（且 lease 可用）的条目，校验 `leaseOwner IS NULL OR leaseUntil < now`，通过后写入 `leaseOwner = tabId, leaseUntil = now + 30s, status = 'sending'`。**每次只 claim 一条**，其余候选条目下次出队循环再处理；
5. 提交事务 → **发送**：发送 HTTP 请求（单条目超时 8s）；
6. **发送成功**：新开 Dexie rw 事务，按 `entry.id + leaseOwner` 条件确认 → 删除条目；
7. **发送失败**：新开 Dexie rw 事务，释放 lease（`leaseOwner = NULL, leaseUntil = NULL`），更新 `attempts += 1`, `lastError`，按退避策略设置 `nextAttemptAt`，回退 `status='pending'`；
8. 返回步骤 1，继续出队循环（直到无可发送条目或所有候选条目均被其他标签页 claim）。

**为什么每次只 claim 一条**：若一次 claim 5 条、lease 固定 30s、逐条发送每条 8s，最坏情况下第 4-5 条尚未开始发送 lease 已过期，另一标签页可重新 claim 导致双发。每次只 claim 一条 + 发送前即时 claim，lease 仅在发送期间占用，消除过期重 claim 窗口。

**刷新/启动恢复**：

- 扫描 `status='sending'` 且 `leaseUntil < now` 的条目 → 说明原持有标签页已崩溃或关闭，释放 lease 回退为 `pending`；
- **不得**把所有 `sending` 无条件改回 `pending`——只能回收已过期 lease；
- 触发出队扫描。

#### 重试与退避

| attempts | 退避（nextAttemptAt） |
|----------|------|
| 1-3 | now + 5s / 15s / 45s（指数退避） |
| 4-6 | now + 5min / 15min / 30min |
| ≥7 | 标记 `dead`，上报遥测 `outbox_dead` |

`idempotency_conflict`（409）不重试，直接标记 `dead` 并释放 lease、上报遥测（原因：outbox 条目内容已冻结，重试不可能改变结果）。

#### 死信（dead letter）

- `status='dead'` 的条目不自动重试；
- 标记 dead 时级联标记所有依赖条目 dead（见依赖链规则）；
- 保留 7 天供人工排查；
- 7 天后由**客户端自行清理**（定时扫描，删除 `createdAt > 7天` 的 dead 条目），**清理前必须确认该 dead 条目的所有依赖条目已全部 dead 且超过保留期**——不得留下孤儿 pending/sending 依赖者；
- 提供诊断 API（`/api/client-diagnostics` 扩展）供查询死信统计。

### 3.5 与现有 shadow-writer 的关系与迁移

**迁移路径**（分步，不一步到位）：

1. **R3.0**：outbox 表创建，与现有 shadow-writer **并存**；
2. **R3.1**：playback 影子写切换为 outbox 模式——`shadowPlaybackProgress` 改为写入 outbox 条目，后台队列发送；
3. **R3.2**：quizAttempt 影子写切换为 outbox 模式；
4. **R3.3**：chat 在 finalized-message outbox 就位后切换（独立阻断分支解除后）。

**共存期**：shadow-writer 和 outbox 通过 kind 区分——playback/quizAttempt 切到 outbox 后，shadow-writer 中对应代码路径由开关保护，关闭时走旧 shadow-writer。

#### 从 playbackState.shadowPending 到 outbox 的原子迁移

切换时存在"旧 pending 未清但 outbox 已接管"的风险，必须设计迁移方案：

1. **迁移时机**：outbox 模式开关首次开启时执行一次性迁移；
2. **迁移步骤**（在 Dexie rw 事务内）：
   - 读取 `playbackState` 中存在 `shadowPending` 字段的行（实际字段是结构化对象，非布尔值）；
   - 对每行生成 outbox 条目（冻结内容，`semanticKey = "playback:<stageId>:latest-progress"`）；
   - 清除 `playbackState.shadowPending` 标记；
   - 提交事务；
3. **防止双发**：迁移后旧 shadow-writer 路径由开关完全关闭（不再直接 HTTP 请求），同一快照不存在旧路径与 outbox 双发；
4. **补偿场景**：若旧 pending 在切换时未被迁移（极端情况：迁移事务与旧 shadow 写竞态），outbox 入队时按 `semanticKey` 压缩会覆盖重复条目；服务端幂等保护防止重复写入；
5. **旧 pending 不丢失**：迁移事务必须在切换前完成，若迁移失败则 abort 切换，保持旧 shadow-writer 路径。

### 3.6 验收矩阵

- [ ] O1：outbox 表创建（含 claim/lease/semanticKey/sequence/dependsOn 字段），与现有 Dexie 表共存，不影响现有读写
- [ ] O2：playback outbox 入队（semanticKey 压缩）→ claim 租约 → 发送 → 条件确认删除，端到端通过
- [ ] O3：quizAttempt outbox 入队 → claim → 发送 → 删除，端到端通过；dependsOn 保证 submit → grade 顺序
- [ ] O4：离线入队 10 条 → 恢复网络 → 全部成功发送，无丢失无重复
- [ ] O5：idempotency_conflict → 标记 dead + 释放 lease，不重试
- [ ] O6：超时 → 指数退避重试（nextAttemptAt 控制），最多 7 次 → dead
- [ ] O7：入队时压缩：3 条同 semanticKey pending → 旧条目标记 superseded，仅最新一条发送
- [ ] O8：跨标签页 claim/lease：标签页 A claim 条目后，标签页 B 扫描时检测到未过期 lease → 跳过；标签页 A 崩溃后 lease 过期 → 标签页 B 可回收并 claim
- [ ] O9：死信 7 天后客户端自行清理，清理前确认无 pending/sending 依赖者
- [ ] O10：三段依赖链死信级联：A→B→C，A dead ⇒ 同一事务内递归标记 B dead ⇒ C dead，遥测 cascadedCount=2
- [ ] O11：dead 清理后后继不得误发：死信清理后，依赖者查询 `succeeded_entries` 无凭据 + outbox 无前置 → `outbox_dependency_lost` → 标记 dead，不误发
- [ ] O12：create 404 重建不与旧 semanticKey 串线：新 create 生成新 UUID，旧依赖链（`dependsOnEntryId` 指向旧 UUID）不会误触发新 create
- [ ] O13：刷新恢复：已过期 lease 的 sending 条目回退 pending，未过期 lease 保持 sending
- [ ] O14：依赖凭据：append 发送前查询 `succeeded_entries` 确认前置已成功，不单凭"条目不在 outbox"推断
- [ ] O15：playbackState.shadowPending → outbox 原子迁移，无丢失、无双发
- [ ] O16：同一 semanticKey 去重：出队前同 key 只取 latest

---

## 第四章：离线/刷新/跨标签页

### 4.1 设计原则

**跨标签页协调必须走数据库事务/CAS/PostgreSQL advisory lock，禁止依赖客户端内存锁。**（勘误 B.3 裁定）

### 4.2 离线场景

#### 离线检测

- 使用 `navigator.onLine` + `online`/`offline` 事件；
- 离线期间：outbox 正常入队，不尝试发送；
- 恢复在线：立即触发 outbox 扫描 + 发送。

#### 离线数据完整性

| kind | 离线期间行为 | 恢复后行为 |
|------|------------|-----------|
| playback | 本地 Dexie 持续落盘，outbox 持续入队（可能 superseded 压缩） | 发送最新 pending |
| quizAttempt | envelope 写入 localStorage | 在线后 shadowQuizSubmitted 发送 |
| chat | 本地 Dexie 落盘，影子写暂停 | 恢复后游标增量发送（当前行为；未来由 outbox 替代） |

### 4.3 刷新（page reload）

刷新后的核心问题：**如何知道哪些数据已经成功写入服务端、哪些还在 outbox 中？**

**方案**：outbox 本身即是最权威的"待发送"清单。刷新后：

1. 扫描 outbox 中 `status='pending'` 或 `status='sending'` 的条目；
2. `status='sending'` 且 `leaseUntil < now`（租约已过期，原标签页已不存在）→ 回退为 `pending`（释放 `leaseOwner`/`leaseUntil`），at-least-once 语义，服务端幂等保证安全；
3. `status='sending'` 且 `leaseUntil >= now` → **保持 sending**（原标签页可能仍在发送），不做变更；
4. 触发 outbox 发送扫描。

对于不使用 outbox 的路径（quizAttempt shadow 阶段），刷新后行为不变（从 envelope 读回）。

### 4.4 跨标签页

#### 问题场景

两个标签页同时打开同一课堂，各自产生影子写。当前风险：

- **chat**：两个标签页共享 localStorage 游标，可能并发发送同一 record ID（当前已存在的问题，勘误 B.3 确认）；
- **playback**：Dexie 事务 + CAS 已处理（条件清除按 eventId，旧请求晚成功不会误删新 pending）；
- **quizAttempt**：localStorage envelope 单键，跨标签页共享，同一 sceneId 只有一个 envelope。

#### 解决方案

| kind | 跨标签页策略 |
|------|------------|
| playback | ✅ 已就位——Dexie rw 事务 + CAS + eventId 条件清除 |
| quizAttempt | ✅ 已就位——localStorage envelope 单键原子性 |
| chat（outbox 后） | outbox 条目按 UUID 唯一，两个标签页各自入队不同条目；`<sessionId>:<msg.id>` 幂等保证不会重复写入 |
| outbox 出队 | 两个标签页各自独立扫描出队；claim/lease 机制保证同一条目不会被两个标签页同时 claim；租约未过期的条目被其他标签页跳过 |

**关键约束**：outbox 出队通过 claim/lease 实现跨标签页互斥——每个标签页独立扫描，但 claim 时校验租约。同一 UUID 条目同一时刻只有一个标签页持有有效租约。服务端幂等保证同 ID 同内容重放安全。同 ID 不同内容会被 409 拒绝并标记 dead（内容已冻结不应发生）。

### 4.5 旧客户端并存

当用户打开一个旧标签页（未刷新，运行旧代码）和一个新标签页（已刷新，运行 R3 代码）时：

- **旧标签页**：继续使用旧 shadow-writer 路径（如果 R3 未删除旧代码）；
- **新标签页**：使用 outbox 路径；
- **数据一致性**：如果旧路径也在写同一 session，可能出现旧 shadow-writer 和新 outbox 同时发送。服务端幂等保护（同 record ID 同内容 → ok_idempotent）。

**建议**：R3 部署后，shadow-writer 和 outbox 至少共存一个版本周期（2 周），通过开关控制切换。

### 4.6 验收矩阵

- [ ] C1：离线 5 分钟 → 恢复在线 → outbox 全部排空，遥测无丢失
- [ ] C2：刷新页面 → outbox 中过期 lease 的 sending 条目回退 pending → 重新发送成功；未过期 lease 保持 sending
- [ ] C3：两个标签页同时 playback → 各自 outbox 入队 → 仅最新一条有效发送 → 旧条目标记 superseded
- [ ] C4：两个标签页同时 quizAttempt → envelope 单键保证不重复
- [ ] C5：旧标签页 + 新标签页并存 → 服务端幂等保护，无数据损坏

---

## 第五章：顺序与冲突

### 5.1 排序模型

当前三种负载有不同的排序语义：

| kind | 本地排序 | 服务端排序 | 一致性要求 |
|------|---------|-----------|-----------|
| playback | capturedAt + eventId 字典序 tie-break | capturedAt + eventId 字典序 tie-break（**非** max seq） | dual-read 本地与服务端使用相同排序规则 |
| quizAttempt | 业务保证 submit → grade 顺序 | seq（append 顺序） | 两条 record 的 seq 顺序需与业务顺序一致 |
| chat | 消息数组顺序 | seq（append 顺序） | 需 seq 与消息顺序一致 |

### 5.2 capturedAt vs server seq

**核心问题**：客户端 `capturedAt`（ms 精度，`Date.now()`）和服务端 `seq`（PostgreSQL serial）是两种不同的排序机制。seq 是到达顺序（append 顺序），受跨标签页和网络延迟影响，**不代表业务快照的新旧顺序**。

**R3 策略**：

- **client 侧排序**：继续使用 `capturedAt` + eventId 字典序 tie-break（R2.1 A2 已签字）；
- **server 侧排序**：seq 仅代表 append 顺序，**不得用于业务排序**；
- **服务端 playback 恢复**：`GET /records/latest` **不能直接取 max seq**。必须按 `payload.capturedAt` 降序 + eventId 字典序 tie-break 选择最新 record。服务端可维护经过该规则折叠的 latest projection（物化或查询时计算）；
- **dual-read 比对**：比对的不是逐 record 一一对应，而是"最新状态是否一致"——对于 playback，本地和服务端使用**相同排序规则**（capturedAt + eventId 字典序）取最新，比对 `sceneId + actionIndex + consumedDiscussions`；对于 quizAttempt，比对 submit/grade 两条 record 的 payload；
- **seq 已签字的用途**：仅表示 append 顺序，用于 `listRecords` 返回排序（保证客户端消费顺序稳定），**不能覆盖已签字的业务排序规则**。

**不要求 `capturedAt` 和 `seq` 全局一致**——它们服务于不同目的。dual-read 比对的是**数据内容**，不是**到达顺序**。

### 5.3 409 IDEMPOTENCY_CONFLICT 处置

#### 当前行为（shadow 阶段）

R2 已签字：shadow 阶段 409 不重试、上报遥测 `idempotency_conflict`。**此行为在 shadow 阶段正确且保持不变。**

#### 切读后（dual-read 及之后）

切读后需要区分两种 409：

| 场景 | record ID | 内容 | 服务端行为 | 处置 |
|------|-----------|------|-----------|------|
| **正常幂等重放** | 相同 | 相同 | 返回已有行（201） | ✅ 正常 |
| **内容漂移冲突** | 相同 | 不同 | 409 | ❌ 需区分处理 |

在 outbox 模型下，内容漂移冲突理论上不应发生（outbox 条目内容已冻结）。如果仍发生，说明存在 bug（例如入队时未正确冻结内容）。

**处置策略（R3）**：

- outbox 发送遇 409 → 标记 dead + 遥测 `idempotency_conflict` + 记录 body hash；
- 服务端扩展 409 响应 body：返回已存储记录的 `content_hash`（SHA-256 of `JSON.stringify(payload)`），供客户端比对；
- 遥测面板新增 `idempotency_conflict` 分布（按 kind、按 body hash 分组）。

### 5.4 并发写入冲突

**场景**：两个标签页同时 append 同一 session 的 record。

- 服务端 `runtime_append_record` RPC 已处理并发（CAS + 行锁）；
- 幂等重放（同 ID 同内容）→ 201，返回已有行；
- 不同 ID → 各自独立写入，seq 按到达顺序分配。

**不需要客户端协调**。

### 5.5 验收矩阵

- [ ] S1：playback dual-read 最新状态比对，≥500 条样本 pass
- [ ] S2：quizAttempt dual-read submit + grade 两条 record 比对，≥200 条样本 pass
- [ ] S3：409 场景：outbox 发送遇 409 → dead + 遥测，不发生无限重试
- [ ] S4：并发 append（同 session 不同 record ID）→ 各自独立写入，seq 递增
- [ ] S5：服务端 `listRecords` 返回按 seq ASC，客户端正确消费

---

## 第六章：读失败降级

### 6.1 降级层级

```
Level 0: 服务端正常 → 使用服务端数据
Level 1: 服务端超时（>5s）→ 降级本地读，上报遥测
Level 2: 服务端 5xx / network error → 降级本地读，上报遥测
Level 3: 服务端返回部分记录（与预期数量不符）→ 合并本地 + 服务端数据
Level 4: 服务端返回 FUTURE_VERSION → 降级本地读，上报遥测（版本不兼容）
Level 5: 服务端连续不可达 >30s → 客户端仍用本地降级读，遥测上报 `config_fallback` 事件，由负责人决策是否手动回退阶段（详见第九章）
```

### 6.2 每 kind 降级策略

三阶段读语义（严格区分）：

| 阶段 | 读源 | 行为 |
|------|------|------|
| **dual-read-compare** | 业务结果**始终使用本地** | 同时读取本地和服务端，服务端数据**仅做异步比对、不上屏**；比对结果上报遥测 |
| **server-preferred** | 服务端成功 → 使用服务端；失败 → 降级本地 | 优先从服务端读，服务端不可达或错误时使用本地兜底 |
| **server-primary** | 服务端是权威源 | 本地仅是明确受限的离线缓存（需定义缓存策略和过期时间），**不得称"服务端唯一读源又本地兜底"** |

#### playback

- **dual-read**：Dexie `playbackState.get(stageId)` → 使用本地结果；同时异步请求 `GET /api/runtime/v1/sessions/pb:<stageId>/records/latest`，比对但不影响 UI；
- **server-preferred**：`GET /api/runtime/v1/sessions/pb:<stageId>/records/latest`（按 capturedAt + eventId 字典序取最新）→ 成功则使用服务端，失败/超时则降级 Dexie；
- **server-primary**：服务端唯一读源；本地 Dexie 作为受限离线缓存（仅网络不可达时使用，需标注缓存时间）。
- `/records/latest` 服务端实现**必须**按 `payload.capturedAt` + eventId 字典序选择，**不得使用 max seq**。

#### quizAttempt

- **dual-read**：localStorage envelope → 使用本地结果；同时异步请求服务端 records，比对但不影响 UI；
- **server-preferred**：`GET /api/runtime/v1/sessions/qa:<stageId>:<sceneId>:<attemptId>/records` → 成功则使用服务端，失败则降级 localStorage；
- 注意：quizAttempt 读需求很低（仅查看历史答题结果），降级成本极小。

#### chat（未来）

- 仅在 finalized-message outbox 就位且阻断解除后进入 dual-read；
- **dual-read**：IndexedDB chat sessions → 使用本地结果；异步比对服务端，不上屏；
- **server-preferred**：`GET /api/runtime/v1/sessions/<chatSessionId>/records`（按 seq 序）→ 成功则使用服务端，失败降级 IndexedDB。

### 6.3 超时与重试

| 操作 | 超时 | 重试 |
|------|------|------|
| 服务端读（dual-read） | 5s | 不重试，直接降级本地 |
| 服务端读（server-preferred） | 8s | 重试 1 次（2s 后），仍失败降级 |
| 服务端读（server-primary） | 8s | 重试 2 次（1s/3s），仍失败降级 |

### 6.4 版本不兼容

服务端返回 `FUTURE_VERSION`（409）表示服务端 schema 版本高于客户端理解的范围：

- 客户端降级本地读；
- 上报遥测 `version_mismatch { serverVersion, clientVersion }`；
- **不静默**——在 UI 中显示非阻塞提示"数据格式已更新，请刷新页面"。

### 6.5 验收矩阵

- [ ] D1：服务端超时（模拟 5s+ 延迟）→ 自动降级本地，UI 无白屏
- [ ] D2：服务端 500 → 自动降级本地，遥测记录
- [ ] D3：服务端返回空 records（session 存在但无 record）→ 使用本地数据
- [ ] D4：FUTURE_VERSION → 降级本地 + UI 提示
- [ ] D5：连续 30s 不可达 → 客户端降级本地读，`config_fallback` 遥测触发，负责人收到告警
- [ ] D6：网络恢复 → 自动探测并恢复阶段（dual-read → server-preferred）

---

## 第七章：登录迁移

### 7.1 当前状态

**R3 拍板**：匿名数据**不纳入**服务端 RuntimeStore 写入。登录后的数据迁移另立 R3+ 设计卡。

现有 merge 端点 `POST /api/runtime/v1/learners/merge` 使用 `runtime_merge_with_grant` RPC 原子搬移。但 R3 匿名数据不写服务端，因此 merge 操作只能搬移已登录用户的数据——匿名阶段的数据在服务端不存在。

### 7.2 R3 只保留接口边界

R3 不实现匿名数据的服务端写入、merge 上传或 local adoption。仅保留以下接口边界供未来 R3+ 使用：

1. **merge API 保持不变**：`POST /api/runtime/v1/learners/merge`，接收 `fromLearnerKey` + `grantId`，返回 `moved: N`；
2. **未来若支持匿名服务端写**：必须使用服务端签发的不透明 learner ID + merge grant，客户端不能自行生成匿名身份；
3. **当前匿名本地数据如需登录后上传**：另立"local adoption/upload"设计卡，不能冒充 server-side merge；
4. **现有匿名 learnerKey**（`ac:<uuid>` 格式）仅用于客户端本地分区，不写入服务端。

### 7.3 验收矩阵

- [ ] M1：匿名用户使用期间，服务端 shadow/outbox 请求数 = 0
- [ ] M2：登录后 merge API 调用 `moved ≥ 0`（含 0 条数据；0 是预期值，因为匿名数据不在服务端）
- [ ] M3：merge-grant 一次性核销，重放返回 403

---

## 第八章：消息完整语义

### 8.1 当前状态

R2 chat record payload 仅含 `{role, content}`：

```typescript
payload: { role: msg.role, content: messageText(msg.parts) }
```

这不足以作为正式读源或审计记录。R2 签字已明确："R3 前不得作为正式读源"。

### 8.2 理想 chat record 字段清单

| 字段 | 优先级 | 当前有无 | 说明 |
|------|:------:|:------:|------|
| `role` | P0 | ✅ | `'user'` / `'assistant'` |
| `content` | P0 | ✅ | 消息全文（finalized 后） |
| `createdAt` | P0 | ✅ | 已在 record 顶层，非 payload 内 |
| `messageId` | P0 | ❌ | UIMessage.id，用于客户端关联 |
| `agentId` | P1 | ❌ | 生成该消息的 agent 标识（区分多 agent 场景） |
| `replyTo` | P1 | ❌ | 回复哪条消息（messageId），构建对话树 |
| `contentHash` | P1 | ❌ | SHA-256 of final content，用于客户端快速比对 |
| `streamingLatencyMs` | P2 | ❌ | 首 token 延迟，诊断用 |
| `totalLatencyMs` | P2 | ❌ | 完整回复延迟 |
| `tokensUsed` | P2 | ❌ | token 消耗（估计值） |
| `attachments` | P2 | ❌ | 图片/文件等附件引用 |
| `metadata` | P2 | ❌ | 扩展元数据（JSON object） |

### 8.3 字段优先级策略

**R3 最低 viably 字段集（P0+P1 共 7 个字段）**：

```typescript
interface ChatRecordPayload {
  role: 'user' | 'assistant';
  content: string;          // finalized content only
  messageId: string;
  agentId?: string;
  replyTo?: string;
  contentHash?: string;     // client-computed, server-verified
}
```

`createdAt` 已在 record 顶层，不重复放入 payload。

### 8.4 contentHash 与内容一致性校验

`contentHash = SHA-256(JSON.stringify({ role, content, messageId }))`

用途（**仅限客户端一致性校验，不是安全/防篡改机制**）：

1. 客户端快速比对：收到服务端 record 后计算 hash 与 `contentHash` 比对，O(1) 确认传输完整性；
2. 409 响应增强：服务端在 IDEMPOTENCY_CONFLICT 响应中返回已存储的 contentHash，客户端可判断差异程度（完全不同的消息 vs 仅 partial→final 漂移）；
3. **注意**：客户端可同时伪造 payload 和 hash，因此 contentHash **不能**作为服务端安全验证或防篡改/审计链证据。教师端聚合如需防篡改保证，需由服务端在写入时自行计算并签名。

### 8.5 实施路径

**chat record payload 扩展分两步**：

1. **R3 早期**（与 finalized-message outbox 同步）：将 payload 从 `{role, content}` 扩展为上述 P0+P1 字段；
2. **R3 后期**（chat 进入 dual-read 前）：所有字段就位且内容完整性验证通过。

**向后兼容**：旧 record（`{role, content}` 格式）在服务端保持不变。新 record 使用新格式。`listRecords` 返回时客户端按 `payload.messageId` 存在与否判断新旧格式。

### 8.6 验收矩阵

- [ ] MS1：chat finalized-message outbox 条目 payload 包含全部 P0+P1 字段
- [ ] MS2：contentHash 生成正确，客户端比对通过（一致性校验，非安全验证）
- [ ] MS3：服务端 409 响应包含已存储 contentHash
- [ ] MS4：新旧格式 record 混合存在时 listRecords 不报错

---

## 第九章：灰度控制面与 SLO

### 9.1 灰度层级

```
全局 → per kind → per stage → per user（百分比/白名单）
```

### 9.2 服务端权威控制面（杜绝客户端自行决定阶段）

**阶段控制不得依赖 localStorage 或客户端 `NEXT_PUBLIC_*` 构建期变量。** 必须设计服务端权威控制面：

#### 控制面配置模型

**内部配置**（服务端存储，不暴露给客户端）：

```typescript
// 内部 RuntimeConfig 存储在服务端数据库，不是 GET 响应类型
interface InternalRuntimeConfig {
  version: number;
  updatedAt: string;
  updatedBy: string;
  kinds: {
    playback?: InternalKindConfig;
    quizAttempt?: InternalKindConfig;
    chat?: InternalKindConfig;  // phase 始终被覆写为 'shadow'
  };
}

interface InternalKindConfig {
  phase: 'local-only' | 'shadow' | 'dual-read-compare' | 'server-preferred' | 'server-primary';
  rolloutPercentage: number;   // 灰度百分比
  allowlist: string[];         // auth.uid[] 白名单（内部使用，不返回客户端）
  killSwitch: boolean;
}
```

**GET 响应**（客户端唯一收到的内容）：

```typescript
interface RuntimeConfigResponse {
  configVersion: number;
  expiresAt: string;      // ISO，客户端缓存过期时间
  kinds: {
    playback?: { effectivePhase: Phase };
    quizAttempt?: { effectivePhase: Phase };
    chat?: { effectivePhase: 'shadow' };  // 永远为 shadow
  };
}
```

**服务端判定逻辑**（percentage、allowlist、killSwitch、hash 全部在服务端计算）：
- 服务端根据 `auth.uid()` + `InternalKindConfig` 计算出该用户每个 kind 的 `effectivePhase`；
- `allowlist` 中的用户直接进入目标阶段；
- 非白名单用户按 `hash(auth.uid, kind, configVersion) % 100 < rolloutPercentage` 判定；
- `killSwitch=true` → `effectivePhase='shadow'`；
- chat 的 `effectivePhase` 服务端**强制覆写为 `'shadow'`**，不依赖客户端遵守；
- 客户端**不执行任何 hash/allowlist/percentage 计算**——它只接收 `effectivePhase` 并执行。

#### 客户端行为

- 客户端启动/唤醒时 `GET /api/runtime/v1/config`，获得 `{configVersion, kinds: {playback: {effectivePhase}, quizAttempt: {effectivePhase}, chat: {effectivePhase}}}`；
- 本地缓存在 `localStorage`（`r3:config`），过期时间 ≤60s，过期后重新拉取；
- **客户端不得自行判定阶段**——不执行 hash、不持有 percentage/allowlist、不做 isInExperiment()；
- **紧急回退**：服务端修改 `killSwitch: true` → `effectivePhase` 变为 `shadow` → 客户端下次拉取生效；
- **白名单**：由服务端判定，客户端只知自己的 `effectivePhase`，不知道是否在 allowlist 中。

#### 配置存储、RBAC 与写权限

| 项目 | 决策 |
|------|------|
| 存储位置 | **唯一选择：`runtime_config` 数据库表**（单行 JSON）。对应 SQL 仍需负责人另行授权。不使用 Vercel 环境变量（`PATCH` API 不能即时修改构建期变量） |
| 谁可以修改 | 仅负责人/管理员通过 `/admin/runtime-control` 控制台调用 `PATCH` |
| 控制台鉴权 | `/admin/runtime-control` 页面由登录管理员访问；前端调用 `PATCH /api/runtime/v1/config` 时携带管理员的 Supabase auth session |
| API 服务端鉴权 | `PATCH` 端点校验：auth.uid() 在 admin 列表中（RBAC）→ 通过后，API 在**服务端内部**使用 service role client 写入 `runtime_config` 表。**禁止把 service-role JWT 交给浏览器页面** |
| 读端点 | `GET /api/runtime/v1/config`（authenticated），返回单用户 `effectivePhase` |
| 未配置时 | 默认阶段 = `'shadow'`（所有 kind），不进入 dual-read |
| 版本保护 | `configVersion` 单调递增；`PATCH` 服务端校验只能递增，拒绝回退 |

#### 配置故障与降级语义

| 场景 | 行为 |
|------|------|
| GET `/api/runtime/v1/config` 成功 | 客户端缓存 ≤60s，按 `effectivePhase` 执行 |
| GET 失败（网络/5xx/超时） | 使用本地缓存（未过期时）；缓存过期后降级 `shadow` |
| 本地缓存过期 + 服务端不可达 | 降级 `shadow`，上报遥测 `config_fallback` |
| 客户端离线 | 使用上次已知配置（不计过期）；所有写进入 outbox，不尝试双读 |
| 配置字段缺失/损坏 | 拒绝解析，降级 `shadow`，上报遥测 `config_parse_error` |

#### 编译期 kill switch（仅作紧急总保险）

保留现有编译期变量作为最后的 kill switch，**不得用于阶段控制**：

```
NEXT_PUBLIC_RUNTIME_SHADOW=1           # 现有，shadow 写 kill switch
NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK=1  # 现有，playback shadow kill switch
```

不再新增任何 `NEXT_PUBLIC_RUNTIME_*` 变量。阶段推进完全由服务端配置驱动。

### 9.3 SLO 指标定义

| 指标 | 定义 | 绿灯阈值 | 黄灯阈值 | 红灯阈值 |
|------|------|:------:|:------:|:------:|
| **shadow_ok_rate** | shadow 写成功率（ok + ok_idempotent）/ 总尝试 | ≥95% | ≥90% | <90% |
| **dual_read_match_rate** | 本地 vs 服务端内容一致率 | ≥99% | ≥95% | <95% |
| **dual_read_missing_rate** | 服务端缺失 record 率 | <1% | <5% | ≥5% |
| **idempotency_conflict_rate** | 409 冲突率（排除正常幂等重放） | <0.1% | <1% | ≥1% |
| **pending_age_p95** | outbox pending 条目年龄 P95 | <60s | <5min | ≥5min |
| **superseded_rate** | superseded 条目 / 总 outbox 条目 | — | — | 仅观测 |
| **read_fallback_rate** | 服务端读降级到本地读的比率 | <1% | <5% | ≥5% |
| **p99_read_latency** | 服务端读 P99 延迟 | <2s | <5s | ≥5s |

### 9.4 回切阈值（手动，负责人依据遥测决策）

任何 kind 满足以下任一条件，**遥测上报 `phase_rollback_recommended` 事件**，由负责人依据遥测手动执行回退（通过控制面 UI 或 `PATCH /api/runtime/v1/config` 修改阶段）：

| 当前阶段 | 建议回退条件 | 建议回退到 |
|----------|---------|--------|
| dual-read | match 率 <95% 持续 >1h | shadow（停止双读比对，仅影子写） |
| server-preferred | read_fallback_rate >5% 持续 >30min | dual-read |
| server-primary | read_fallback_rate >10% 持续 >5min | server-preferred |

回切完成后更新配置 `phase` 字段，客户端下次拉取（≤60s）生效。**当前不实施 SLO 自动回退**——需要服务端聚合与执行器，Cron/生命周期执行器已移出 R3，自动化另立卡。

### 9.5 控制面 UI

在 Vercel Preview 环境增加控制面页面（`/admin/runtime-control`，仅 dev/preview 可见）：

- 显示当前各 kind 的阶段（从服务端配置读取）；
- 显示核心 SLO 指标（最近 1h/24h）；
- **修改 per-kind 阶段、rollout percentage、allowlist、kill switch**（需确认，记录操作日志和审计人）；
- 配置版本号自动递增；
- 注意：`/admin/runtime-control` 修改的是**服务端配置**，不是构建期 `NEXT_PUBLIC_*`。

### 9.6 验收矩阵

- [ ] GC1：服务端 `/api/runtime/v1/config` 返回 per-kind 阶段配置
- [ ] GC2：服务端根据 auth.uid() + hash 判定返回 effectivePhase，同一用户多次请求结果一致
- [ ] GC3：服务端 kill switch 开启 → 客户端 ≤60s 内回退 shadow
- [ ] GC4：服务端 allowlist 判定正确，白名单用户收到目标 phase，非白名单按 percentage hash 判定
- [ ] GC5：`PATCH /api/runtime/v1/config` 拒绝非 admin 用户（403），拒绝 teacher 用户（403），拒绝匿名用户（401）
- [ ] GC6：`PATCH` 成功后 `runtime_config_audit_log` 记录 updatedBy + updatedAt + 变更前后 diff
- [ ] GC7：service-role JWT 不出现在任何浏览器可见的响应/HTML/JS bundle 中
- [ ] GC8：match 率跌破 95% 或 read_fallback_rate 超过阈值时，遥测 `phase_rollback_recommended` 事件，由负责人依据遥测手动回退（通过控制面 UI 或配置端点）；**当前不实施 SLO 自动回退**（需要服务端聚合与执行器，Cron 已移出 R3，自动化另立卡）
- [ ] GC9：pending_age_p95 计算正确，superseded 不计入成功率分母
- [ ] GC10：构建期 `NEXT_PUBLIC_RUNTIME_SHADOW*` 仅保留为 kill switch，无新增

---

## 第十章：数据生命周期与教师聚合边界

### 10.1 保留策略（沿用已签字决策）

R3 沿用 R1.1/R2 已签字的保留政策，**不在 R3 切读设计中新增或修改数据生命周期规则**。

| 数据类别 | 保留期 | 到期动作 | 依据 |
|---------|:-----:|---------|------|
| runtime_sessions（archived 状态） | **24 个月** | 归档后清理 | R1.1/R2 已签字 |
| runtime_records | 跟随 session | 跟随 session | 父子关系 |
| runtime_merge_grants | 7 天 | 硬删除 | grant 是短期一次性 token |

**R3 不实施**以下操作（需另立设计卡并单独授权 SQL）：
- 按 `updatedAt` 自动软删除
- `deleted_at` / `deleted_reason` schema 变更
- GDPR/用户删除 RPC
- 物化聚合视图
- Vercel Cron / pg_cron 定时任务
- 服务端 outbox dead 条目的定时清理

### 10.2 客户端 outbox 清理

- outbox dead 条目由**客户端自行清理**（定时扫描，删除 `createdAt > 7天` 的死信）；
- 不依赖服务端定时任务清理客户端数据。

### 10.3 教师聚合边界（移出 R3）

R1.1 已建立"无教师直通 RLS"原则——教师不能直接查询 learner 分区。教师查询走 service role API。

**教师聚合 API 移出 R3 范围**，另立需求。R3 仅保留以下接口边界：

- `GET /api/runtime/v1/analytics/course/<courseId>`：接口定义保留，实现不在 R3；
- `GET /api/runtime/v1/analytics/stage/<stageId>`：接口定义保留，实现不在 R3；
- 聚合数据预计算方案（物化视图/定时 job）不在 R3 选型。

### 10.4 定时任务（移出 R3）

归档/保留执行器、定时清理等需另立生命周期设计卡，**不能阻塞 R3 切读推进**。R3 使用的 outbox 重试由客户端定时器驱动（`setInterval`），不依赖服务端 cron。

### 10.5 验收矩阵

- [ ] L1：outbox dead 条目 7 天后客户端自行清理
- [ ] L2：R3 代码路径不触发任何数据生命周期变更（软删除、归档、硬删除）

---

## 第十一章：Preview/Production 发布

### 11.1 环境隔离原则

| 环境 | Supabase | 开关 | 数据 | 部署方式 |
|------|----------|------|------|---------|
| **Preview** | `ufwkylcsrppaamzqsvgx` | 全部可开 | 测试数据，可随时重置 | Vercel Preview（per branch deploy） |
| **Production** | `aqmktsagfvkikehynpdw` | 仅负责人授权 | 真实业务数据，禁止写入测试数据 | Vercel Production（main branch） |

**红线**：Preview 和 Production 不得共用 Supabase 项目。当前已满足（两个独立项目）。

### 11.2 Preview 发布流程

1. **代码推送** → Vercel 自动 Preview deploy；
2. **构建验证**：bundle 字面量检测法确认现有 `NEXT_PUBLIC_RUNTIME_SHADOW*` 变量已内联；
3. **无缓存 Redeploy**：仅当新增/修改了 `NEXT_PUBLIC_*` kill switch 变量时需要；
4. **冒烟测试**：登录态 E2E（playback + quizAttempt + chat 影子写）；
5. **遥测观察**：至少 24h 影子写 ok 率达标；
6. **阶段推进**：通过服务端配置逐步推进（shadow → dual-read）。本次授权上限为 dual-read，server-preferred/server-primary 在各自子设计卡签字前不得在 Preview 推进。

### 11.3 Production 发布流程

**Production 任何操作均需负责人单独书面授权。** 流程：

1. **Preview 验证通过**：所有 R3 门禁在 Preview 全部绿灯；
2. **负责人授权**：逐项授权（SQL、开关、部署）；
3. **Production SQL 执行**：在授权后执行 schema 变更（outbox 表不需要，仅客户端 Dexie；服务端 schema 变更除外）；
4. **Production 开关开启**：先确认 `NEXT_PUBLIC_RUNTIME_SHADOW=1`（kill switch 放开），阶段推进通过服务端 `/api/runtime/v1/config` 逐步配置；
5. **Production 部署**：无缓存 Redeploy；
6. **Production 观察**：至少 7 天，SLO 全部绿灯；
7. **逐阶段推进**：shadow → dual-read（本次授权上限；每阶段观察 ≥7 天）。server-preferred/server-primary 需各自子设计卡签字后方可推进。

### 11.4 环境变量安全

- `NEXT_PUBLIC_RUNTIME_SHADOW*`：编译期内联 kill switch（仅保留 2 个现有变量），不敏感但影响代码路径。变更后必须无缓存 Redeploy；
- 阶段控制配置：由服务端 `/api/runtime/v1/config` 下发，无需构建期变量变更；
- `Sensitive` 类型环境变量：构建期不可见，Turbopack 会将守卫折叠为 `false` → DCE 掉代码；慎用；
- Supabase service role / Vercel token：禁止写入文档、提交或聊天；历史泄露视为已失效。

### 11.5 验收矩阵

- [ ] PP1：Preview 构建后 bundle 字面量检测法确认开关内联
- [ ] PP2：Preview → Production 发布前负责人书面授权确认
- [ ] PP3：Production 发布后回滚演练通过（关开关 → 无缓存 Redeploy）
- [ ] PP4：每次阶段推进在 Preview 先验证 ≥24h 后才能在 Production 推进

---

## 第十二章：回滚

### 12.1 回滚层级

| 层级 | 操作 | 影响 | 恢复难度 |
|------|------|------|:------:|
| **L1：调整阶段配置** | 服务端配置回退 phase 或开启 kill switch | 客户端回退读源，服务端数据不变 | 极小——重新推进即可 |
| **L2：回退代码** | git revert + redeploy | 服务端数据不变，客户端回到旧逻辑 | 小——需一次部署 |
| **L3：保留表回滚** | 回退代码 + 保留 runtime 表 | 新数据停止写入，旧数据保留 | 中——需清理未完成迁移 |
| **L4：DROP 回滚** | DROP runtime_* 表 | ⚠️ 数据丢失 | **禁止**（写入业务数据后） |

### 12.2 各阶段回滚操作

| 当前阶段 | 回滚目标 | 操作 |
|----------|---------|------|
| shadow | local-only | 关 `NEXT_PUBLIC_RUNTIME_SHADOW`（及子开关），保留遥测数据 |
| dual-read | shadow | 服务端配置将 phase 改为 `shadow`，客户端 ≤60s 内回退 |
| server-preferred | dual-read | 服务端配置将 phase 改为 `dual-read-compare`，客户端 ≤60s 内回退 |
| server-primary | server-preferred | 服务端配置将 phase 改为 `server-preferred`，客户端 ≤60s 内回退 |

紧急场景可启用 kill switch：服务端设置 `killSwitch: true` → 客户端立即回退 shadow。编译期 `NEXT_PUBLIC_RUNTIME_SHADOW=0` 作为最后手段（需无缓存 Redeploy）。

### 12.3 关键红线

1. **写入任何业务 runtime 数据后，禁止 DROP runtime_* 表回滚**（R1.1/R2 均已签字）；
2. 仅"未写入任何业务数据的窗口"允许 DROP 物理回滚——该窗口在 R2 shadow 开启后已关闭；
3. 回滚后 runtime 表及其中数据保留，供后续问题排查和恢复；
4. outbox 客户端数据（IndexedDB）：回滚不清除，下次开启自动恢复发送。

### 12.4 回滚演练

在进入 server-preferred 前，**必须完成一次回滚演练**：

1. 在 Preview 环境模拟 server-preferred 场景；
2. 关闭开关 → 验证客户端回退到 dual-read；
3. 再关闭 dual-read 开关 → 验证回退到 shadow；
4. 确认整个过程中无数据丢失、无 UI 异常；
5. 演练记录写入 `docs/reports/`。

### 12.5 验收矩阵

- [ ] RB1：服务端配置 phase 回退 → 客户端 ≤60s 内回到上一阶段，遥测确认
- [ ] RB2：编译期 kill switch 关闭 → 客户端回到 local-only，0 网络请求（需无缓存 Redeploy）
- [ ] RB3：回滚演练完整执行并记录
- [ ] RB4：回滚后重新开启 → 数据恢复，无丢失

---

## 第十三章：chat 独立阻断分支（专章）

> **本章标注**：chat 阻塞于 finalized-message 信号 + 持久化不可变 outbox 方案。本章不分配 chat 的阶段状态机推进路径；与其被标为"无法推进"不如明确阻断条件，避免虚假进展。

### 13.1 阻断原因清单

| 阻断项 | 严重程度 | 说明 |
|--------|:------:|------|
| **缺少 finalized-message 信号** | 🔴 阻断 | 不知道消息何时完成流式揭示，影子写可能写入 partial 内容 |
| **缺少持久化不可变 outbox** | 🔴 阻断 | localStorage 游标跨标签页不安全；无冻结内容机制 |
| **payload 字段不完整** | 🟡 部分 | `{role, content}` 不足以作为正式读源（见第八章） |
| **content 漂移** | 🟡 高置信推断 | 勘误 B.1：高置信推断，待门禁测试证实 |

### 13.2 为什么 mutex 不够

勘误 B.2 裁定：per-session mutex 串行化 `shadowChatSessions` 解决的是 409 冲突**症状**，不是数据完整性问题。

| 状态 | partial 写入 | final 写入 | 日志表现 | 数据可切读？ |
|------|:---------:|:--------:|---------|:----------:|
| 无 mutex（当前） | ✅ | 409 → 游标卡死 | 红色（冲突遥测） | ❌ |
| 仅加 mutex | ✅ | ❌（游标已前进） | 绿色（无冲突） | ❌ |

**结论**：chat 数据完整性的正式方案必须以 finalized-message 信号或持久化不可变 outbox 为核心。mutex 仅可作辅助并发控制手段。

### 13.3 chat outbox 子设计要点

以下是 chat outbox 设计的**问题清单**（不是答案——需要独立的 chat outbox 设计卡）：

1. **消息何时 finalize？——D3 已拍板：必须使用显式终态事件**
   - **正常结束**：`onAgentEnd` 事件 + 最后一次 `onTextReveal` 后 action 就绪 → finalize；
   - **中断**（`endSession`/`softPauseSession`/用户主动停止）→ finalize 当前已揭示内容；
   - **错误**（SSE 断开/网络错误）→ finalize 当前已揭示内容，标注 `finalizedReason: 'error'`；
   - 静默超时**只能作为兜底**（如 >30s 无 tick 且无 end/error 事件），**不能作为权威 finalize 信号**；

2. **finalized message 如何进入持久化 outbox？——D4 已拍板：finalize 时写一次不可变条目**
   - **不接受**每次流式变化入队（会淹没 outbox 和产生大量 superseded）；
   - finalize 时冻结 content、计算 contentHash、写入一条不可变 outbox 条目（`semanticKey = "chat:<sessionId>:<messageId>"`）；
   - 入队后内容永不再变；

3. **content hash 如何用于完整性验证？**
   - 客户端 finalize 时计算 `contentHash = SHA-256(payload)`；
   - 写入 outbox 时一并冻结；
   - 服务端可返回已存储 hash 供比对；

4. **跨标签页协调**
   - outbox 条目 UUID 唯一，两个标签页各自入队——天然互不干扰；
   - 同一 session 的消息：两个标签页发送各自 finalized message → 不同 record ID → 各自写入；
   - 注意：两个标签页可能各自产生部分重复消息（各自 SSE 连接）——这属于业务层问题，不是 outbox 层问题。

5. **与现有 shadow-writer 的过渡**
   - 现有 `shadowChatSessions` 保留（开关控制），直到 chat outbox 就位并验证；
   - outbox 就位后，`shadowChatSessions` 改为仅写入 outbox 条目，不再直接 HTTP 请求；
   - 最终：`shadowChatSessions` 废弃，全部由 outbox 接管。

### 13.4 chat 阻断解除条件

chat 可以进入 dual-read 的门禁（全部必须满足）：

- [ ] CH1：finalized-message 信号实现，所有场景（正常结束/中断/错误）均有确定行为
- [ ] CH2：持久化 outbox 就位，内容冻结 + UUID 唯一
- [ ] CH3：payload 字段扩展至 P0+P1（见第八章）
- [ ] CH4：门禁测试：finalized message content 一致性验证（模拟流式 → finalize → outbox 入队 → 服务端写入 → 读回比对）
- [ ] CH5：跨标签页测试：两个标签页各自聊天 → outbox 条目不冲突
- [ ] CH6：≥200 条 chat records dual-read match 率 ≥99%

---

## 第十四章：R4 接口边界

### 14.1 原则

**R3 客户端不得绑定 Supabase 专有实现，继续走 HTTP contract。**

R4 的目标是"同一 HTTP contract 的私有化 Postgres 后端"——这意味着服务端可以从 Supabase 换成裸 PostgreSQL，但客户端代码零改动。

### 14.2 当前 HTTP contract 清单

| 端点 | 方法 | 用途 | Supabase 耦合点 |
|------|------|------|----------------|
| `/api/runtime/v1/sessions` | POST/GET | 会话管理 | service role client → RPC |
| `/api/runtime/v1/sessions/[sessionId]/records` | POST/GET | 记录读写 | service role client → RPC |
| `/api/runtime/v1/sessions/[sessionId]/status` | PATCH | 状态流转 | service role client → RPC |
| `/api/runtime/v1/learners/merge` | POST | 身份合并 | service role client → RPC |

### 14.3 R3 新增端点（保持同一 HTTP contract）

| 端点 | 方法 | 用途 | 说明 |
|------|------|------|------|
| `/api/runtime/v1/sessions/[sessionId]/records?sceneId=X&limit=N` | GET | 分页读（现有 GET 扩展） | 支持 limit 参数，R3 dual-read 需要 |
| `/api/runtime/v1/sessions/[sessionId]/records/latest` | GET | 取最新 record | playback 恢复场景 |
| `/api/client-diagnostics` | POST（扩展） | 遥测上报 + outbox 统计 | 已有，R3 扩展 outbox 相关字段 |

### 14.4 Supabase 专有实现的隔离

当前 `RuntimeStorePg` 通过 `createSupabaseRpcClient` 调用 Supabase RPC。这是服务端实现细节，客户端不可见：

- 客户端只发 HTTP 请求到 `/api/runtime/v1/*`；
- 服务端 `lib/server/runtime-store/` 是对 `RuntimeStore` 接口的实现；
- R4 替换为裸 PostgreSQL 时，只需重写 `lib/server/runtime-store/pg.ts`，保持接口不变，HTTP 路由不变。

**R3 新增功能（dual-read API、outbox 端点的服务端部分）必须遵循同一模式**——在 `RuntimeStore` 接口中定义，在 `RuntimeStorePg` 中实现。

### 14.5 R4 前置条件

R3 必须为 R4 准备好：

1. **稳定的 HTTP contract**：端点、请求/响应 shape、错误码在 R3 结束时冻结（允许新增字段，不允许破坏性变更）；
2. **完整的接口文档**：每个端点的 Request/Response JSON Schema；
3. **抽象接口**：`RuntimeStore` interface（TypeScript）已定义，R4 只需新实现；
4. **测试套件**：contract tests（不依赖 Supabase，可对任何 `RuntimeStore` 实现运行）。

### 14.6 验收矩阵

- [ ] R4B1：所有客户端代码仅通过 HTTP 访问 RuntimeStore，无直接 Supabase 调用
- [ ] R4B2：`RuntimeStore` 接口定义完整，包含 R3 新增方法
- [ ] R4B3：Contract tests 可对 mock 实现运行（不依赖 Supabase）
- [ ] R4B4：端点请求/响应 JSON Schema 文档就位

---

## 附录 A：术语表

| 术语 | 定义 |
|------|------|
| **shadow write** | 影子写：主写到本地存储，同时异步镜像一份到服务端，服务端写入失败不影响本地 |
| **dual-read compare** | 双读比对：业务结果始终使用本地，同时异步从服务端读取数据仅做比对，不上屏 |
| **server-preferred** | 服务端优先：优先从服务端读数据，服务端成功才使用服务端，不可达/错误时降级本地 |
| **server-primary** | 服务端权威：服务端是唯一权威读源，本地仅作受限离线缓存（需明确缓存策略），不得称"服务端唯一读源又本地兜底" |
| **outbox** | 待发送队列：持久化的"待发送到服务端的操作"列表 |
| **pending** | outbox 中等待发送的条目 |
| **dead letter** | 死信：重试耗尽后不再尝试的 outbox 条目 |
| **lease / claim** | 租约/认领：跨标签页互斥机制——发送前 claim 租约（写入 tabId + 30s 过期），发送成功后条件确认删除，失败释放租约 |
| **semanticKey** | 语义键：用于 outbox 压缩和去重的业务语义标识（如 `playback:<stageId>:latest-progress`），不同于 UUID 主键 |
| **superseded** | 被新快照覆盖的旧 pending（本地丢弃，不发请求） |
| **idempotency conflict** | 幂等冲突：同一 record ID 发送了不同内容，服务端返回 409 |
| **finalized message** | 已完成的聊天消息：流式揭示结束、action 就绪、内容不再变化 |
| **merge-grant** | 合并授权：一次性短期 token，授权将匿名 learner 数据迁移到登录用户 |
| **content hash** | 内容哈希：`SHA-256(payload)`，用于快速比对和完整性验证 |
| **SLO** | 服务等级目标：如 shadow ok 率 ≥95%、match 率 ≥99% |

## 附录 B：引用列表

| 文档 | 路径 | 用途 |
|------|------|------|
| R2 签字报告 | `docs/reports/2026-07-30-runtimestore-r2-signed.md` | R2 已签字决策 |
| R2.1 A2 签字报告 | `docs/reports/2026-08-02-runtimestore-r2.1-a2-signed.md` | R2.1 已签字决策 |
| R2.1 Preview E2E | `docs/reports/2026-08-02-runtimestore-r2.1-playback-preview-e2e.md` | Preview 实测证据 |
| chat 冲突调查报告 | `docs/reports/2026-08-02-runtime-chat-idempotency-conflict.md` | chat 阻断根因分析（含勘误 B） |
| Codex 交接文档 | `docs/reports/2026-08-02-codex-handoff-runtime-r3.md` | 主线上下文 |
| R2.1 设计卡 | `docs/reports/2026-07-31-runtimestore-r2.1-playback-design.md` | playback 设计依据 |

## 附录 C：R2/R2.1 不可重开决策清单

| # | 决策 | 来源 |
|---|------|------|
| 1 | chat payload = `{role, content}`，R3 前不作为正式读源 | R2 |
| 2 | quizAttempt 单键 envelope 原子写，影子从 envelope 读回 | R2 |
| 3 | 影子路径身份/答案必须从持久化状态读回 | R2 |
| 4 | 匿名期不影子写；access code 不能作分区键 | R2 |
| 5 | 409 `IDEMPOTENCY_CONFLICT` shadow 阶段不重试但遥测 | R2 |
| 6 | playback 事务内 UUID + 冻结内容 + 条件清除 | R2.1 A2 |
| 7 | playback 最新快照按 capturedAt + eventId 字典序 tie-break | R2.1 A2 |
| 8 | completed PATCH 失败保留 pending 补偿 | R2.1 A2 |
| 9 | superseded 标记 `source: local_drop` | R2.1 A2 |
| 10 | playback 双开关门禁（总开关 + 子开关） | R2.1 A2 |

## 附录 D：开放决策点（v1.1 全部拍板）

| # | 决策点 | 拍板结果 | 生效章节 |
|---|--------|---------|---------|
| **D1** | outbox 是否新建 Dexie 表？ | ✅ 新建独立 `runtimeOutbox` 表，不复用 playbackState | 第三章 |
| **D2** | 匿名数据是否在 R3 写入服务端？ | ✅ R3 **不纳入**匿名服务端写；登录迁移另立 R3+ 卡 | 第七章 |
| **D3** | chat finalized-message 信号选择？ | ✅ 必须使用**显式终态事件**；正常结束/中断/错误分别 finalize；静默超时仅兜底 | 第十三章 |
| **D4** | chat outbox 条目策略？ | ✅ 选"**finalize 时写一次不可变条目**"；不接受每次流式变化入队 | 第十三章 |
| **D5** | 教师聚合 API 是否纳入 R3？ | ✅ **移出 R3**，另立需求；R3 只保留接口边界 | 第十章 |
| **D6** | 定时任务选型？ | ✅ **不在 R3 选型**；归档/保留执行器另立生命周期卡 | 第十章 |
| **D7** | 用户级灰度方案？ | ✅ 采用 stable hash 分配，**阶段与百分比由服务端权威配置下发**，客户端不能自行决定阶段 | 第九章 |
| **D8** | `NEXT_PUBLIC_*` 开关管理？ | ✅ **否决继续堆 7 个**；保留紧急 kill switch，阶段控制改为服务端 per-kind 配置 | 第二章、第九章 |

---

> **本文状态：v1.1 第二轮修订完成，待 Codex/负责人复审签字（review requested，非已批准方案）。**
> 
> v1→v1.1 变更摘要：
> - D1-D8 八项开放决策已拍板并融入正文
> - 阻断点 1-8 已关闭（outbox claim/lease、依赖顺序、playback 压缩键、dual-read 语义、
>   服务端排序、服务端控制面、匿名范围收口、生命周期收口）
> - 三处额外修正（删除 partial_match、contentHash 降为一致性校验、quiz G2.3 语义修正）
> - v1.1→v1.1r2 6 项实施级阻断点修正：
>   分支信息修正；逐条即时 claim（不批量预占）；dead 级联标记 + per-session 序列链；
>   quiz semanticKey 按业务相位区分；控制面安全/RBAC/故障语义 + chat 强制 shadow；
>   server-primary 缓存契约推迟 + v1.1 授权上限设为 dual-read
> 
> 复审签字前：继续不实施代码、不执行 SQL、不改环境变量。
> 评审通过后，chat 阻断分支需独立起草 finalized-message outbox 设计卡；
> playback + quizAttempt 可按本设计稿的阶段状态机推进实施（上限 dual-read）。
