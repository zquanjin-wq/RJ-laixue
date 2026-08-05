# Codex 交接：RuntimeStore R3.1a Playback cycle 设计评审

日期：2026-08-05  
仓库：`D:\WorkBuddy 地界\RJ-laixue-storage-b2`  
分支：`test/r3-line`  
当前 HEAD：`44f6d26b`  
远端：`origin/test/r3-line` 与本地 HEAD 一致  
交接前工作树：干净；当前仅本交接文档为新增未提交文件  
当前任务：继续评审 R3.1a Playback 跨会话生命周期设计；**尚未授权实施**

---

## 0. 背景：这条 RuntimeStore 线为什么存在

### 0.1 主问题

锐捷来学课堂运行时数据长期以浏览器本地存储为主，包括：

- Chat 会话和消息；
- Quiz 的 submitted/reviewed 状态、答案与批改结果；
- Playback 的场景位置、action cursor、完成状态与恢复快照。

本地优先保证了课堂在弱网、刷新和旧版本数据下仍能工作，但也带来几个长期问题：

- 数据只留在单个浏览器，无法形成可靠的跨设备学习记录；
- 教师端、统计端和后续 AI 分析无法使用统一的服务端 runtime 数据；
- 浏览器刷新、跨标签页、写失败和生命周期切换容易产生局部状态；
- 如果直接切换读源，任何服务端缺写、乱序或幂等错误都会改变现有课堂行为。

RuntimeStore 主线的目标不是重写课堂，而是建立一条可逐步验证的服务端运行时存储链：

```text
本地业务行为保持不变
        ↓
服务端 shadow write（只镜像、不参与业务读）
        ↓
可靠 outbox（离线、失败、刷新后可补偿）
        ↓
dual-read 异步比对（本地主读，不上屏服务端结果）
        ↓
未来才可能 server-preferred / server-primary
```

因此，当前所有设计都必须服从两个总原则：

1. **影子写是已持久化本地状态的函数**，不能使用调用方临时内存值伪造成功；
2. 在服务端数据完整性和恢复语义没有门禁证明前，不能切换业务读源。

### 0.2 与主任务的关系

RuntimeStore 是课程运行时数据持久化主线的一部分，不是独立的临时功能。它最终服务于：

- 学习进度跨设备恢复；
- 教师查看真实学习过程；
- 课堂行为统计和后续智能分析；
- 本地 DocumentStore 与服务端数据逐步收敛。

当前工作没有偏离主任务：R3.1a 正在修复可靠写链暴露出的生命周期漏洞。若该漏洞不修复就进入 dual-read 或 Production，服务端会缺失用户重看课程产生的 Playback 数据，并在浏览器中留下永久重试的 outbox。

### 0.3 阶段演进

这条线按风险逐层推进：

#### R1 / R1.1：服务端基础能力

- 建立 `runtime_sessions`、`runtime_records` 等服务端结构；
- 实现 create session、append record、set status 路由；
- 验证登录态、RLS、service-role、RPC 权限收口；
- 所有 SQL 只在隔离 Preview Supabase 验证，Production SQL 始终需要负责人单独授权。

#### R2：Chat 与 Quiz shadow write

- 总开关默认关闭；
- Chat 与 quizAttempt 仅影子写，业务仍读本地；
- Quiz attemptId 与 answers 改为单键 envelope 原子持久化；
- submitted/reviewed 使用确定性 session/record identity；
- Playback 因本地持久化链尚未接通，从 R2 移出。

#### R2.1：Playback 本地恢复与 shadow write

- A1 接通 Playback 本地落盘、刷新恢复、关键事件 flush；
- A2 增加结构化 pending、条件清除、失败补偿和 Preview shadow E2E；
- 这一阶段仍以 direct shadow writer 为主，部分错误是 fire-and-forget，未形成永久队列，因此没有充分暴露 session 生命周期问题。

#### R3.0：通用可靠 outbox

- Dexie outbox、lease/CAS、依赖链、成功凭据和递归 dead；
- create/append/status 按严格路由发送；
- 404 重建、409 分类、刷新和退避恢复；
- 目标是让失败请求不丢失，同时不重复或越过前置操作。

#### R3.1：Playback 切换到 outbox

- Playback 快照从 direct HTTP 切换到 outbox；
- 增加迁移、调度、completed 清理与依赖感知；
- 代码门禁通过并签字，但当时没有覆盖“session 已 completed 后再次进入课程”的真实 E2E。

#### R3.2：Quiz 切换到 outbox

- Quiz 使用严格链与 `runtimeChainHeads`；
- 最终链顺序修正为：

```text
create(active) → submitted → reviewed → completed → archived
```

- Preview E2E 已验证通过。

#### R3.1a：当前补充设计

R3.2 通过后进行 chat/playback/quiz 完整人工回归，才发现 Playback 的确定性 session ID 始终是：

```text
pb:<stageId>
```

第一轮播放完成后，服务端把该 session 标为 completed。用户重新进入课程产生新快照时，客户端仍向同一 session append，服务端按既有契约返回 `409 INACTIVE_SESSION`。可靠 outbox 不会像 fire-and-forget 一样静默丢弃，于是该条目永久退避重试。

R3.1a 因此不是推翻 R3.1，而是补齐 R3.1 未覆盖的 **跨 completed playback cycle identity**：

```text
pb:<stageId>:<visitId>
```

同一个未完成 cycle 在 F5 后复用；completed 成功后的下一轮有效播放必须生成新 visitId 和新服务端 session。

### 0.4 当前协作与决策方式

此前工作采用明确的“起草—评审—修订—签字—实施—Preview E2E”门禁：

- 文档作者/实现工具负责起草和按评审修订；
- Codex 负责独立检查状态机、事务、幂等、恢复和真实 E2E，不根据摘要直接签字；
- 项目负责人掌握 Production、SQL、环境变量和数据清理的最终授权；
- 能控制已登录浏览器的工具负责 Preview 人工验证和 Vercel 日志取证；
- WorkBuddy 无法控制电脑，不能承担真实人工浏览器回归。

对新模型的要求：不要因为 v0.5 被称为“最后一轮”就降低签字标准。设计签字表示实现者可以照文档直接编码，因此伪代码中的索引、事务、依赖方向和异步协议也必须成立。

---

## 1. 一句话状态

R3.0、R3.1、R3.2 的代码签字仍有效，R3.2 Quiz Preview E2E 已通过；但完整 Preview 回归发现 Playback 在 completed 后复用 `pb:<stageId>` 会持续收到 `409 INACTIVE_SESSION`，因此 **Production 仍是 NO-GO**。R3.1a 设计已经修订到 v0.5，但还有三个可执行伪代码级 P0，**不得签字、不得开始实现**。

---

## 2. 不可突破的授权边界

以下操作均未授权：

- Production 部署或配置修改；
- Supabase SQL；
- 任何环境变量修改，包括关闭或修改 Preview 子开关；
- R3.x dual-read/控制面实施；
- 数据库测试数据或旧 outbox 条目清理；
- R3.1a 未签设计的代码实施。

当前允许的工作只有：

- 阅读仓库与报告；
- 评审、修订和签署设计文档；
- 设计签字后，再由负责人另行授权实施。

---

## 3. 已签里程碑

| 里程碑 | Commit | 状态 |
|---|---|---|
| R3 总设计稿 v1.1 | `2856dbe2` | SIGNED；授权上限为 playback/quizAttempt dual-read 设计，当前仍未启动 R3.x |
| R3.0 outbox 基础设施 | `6e9c5a28` | 代码 SIGNED |
| R3.1 playback outbox | `ae3362b7` | 代码 SIGNED；本次发现的是跨 completed cycle 生命周期缺口 |
| R3.2 quiz outbox code | `416747e2` | 代码 SIGNED |
| R3.2 Quiz E2E 顺序修复 | `4a570ff1` | `create → submitted → reviewed → completed → archived` 通过 |
| R3.2 Preview E2E 报告 | `c1e67c17` | SIGNED |

注意：上述代码签字不等于 Production 放行。完整 Preview 回归已经把 Production 决策改为 NO-GO。

---

## 4. Production NO-GO 的直接证据

权威报告：

- `docs/reports/2026-08-05-r3-preview-regression-observation.md`

部署与测试环境：

- 分支 Preview：`https://rj-laixue-git-test-r3-line-rj-laixue.vercel.app`
- Vercel deployment：`ATycMRWNLVWRp7oUih2m9rvanyPm`
- 修复 commit：`4a570ff1`
- 测试课程：`7YsMN9Bdoz`
- Preview Supabase：`ufwkylcsrppaamzqsvgx`
- Production Supabase `aqmktsagfvkikehynpdw` 全程禁止写入。

### 4.1 Quiz

新 attempt `163aee7d-fd38-43df-9fbd-70f1672bcdf1`：

1. create 201
2. submitted 201
3. reviewed 201
4. completed 200
5. archived 200

刷新后没有重发该成功链。R3.2 本身通过。

### 4.2 Chat

Runtime create/append/status 均成功，`runtime_shadow` 遥测为 `ok`。教师 Agent 返回空内容属于 Provider/Agent 层，本轮判为 Runtime PASS、业务 PARTIAL，不是 R3 Production 的核心阻断。

### 4.3 Playback P0

会话 `pb:7YsMN9Bdoz`：

- 首轮 records 201；
- completed status 200；
- 用户重新进入、播放或切场景后仍复用同一 session；
- 后续 records 连续 409，并按退避持续重试；
- outbox 无法排空。

根因：服务端只允许向 active session append；客户端把已 completed 的确定性 `pb:<stageId>` 继续用于下一轮播放。

另观察到：

- Playback 相邻窗口至少三次 `/api/client-diagnostics` 400；
- 修复前旧 Quiz 失败条目仍能在浏览器旧 outbox 中复活重试。

---

## 5. R3.1a 设计评审历史

权威设计文件：

- `docs/reports/2026-08-05-r3.1a-playback-visit-session-design.md`

| 版本 | Commit | 结果 |
|---|---|---|
| v0.1 | `f9bde94f` | 否决：visit 边界、单行状态、complete 顺序、legacy、门禁缺失 |
| v0.2 | `fadf4376` | 否决：跨标签页仍串 visit、凭据关联与事务缺口 |
| v0.3 | `427f2122` | 否决：主键迁移、entry identity、错误响应格式等 |
| v0.4 | `e3aa0049` | 否决：claim 占位、legacy identity、中央错误解析等 |
| v0.5 | `44f6d26b` | 当前版本；总体模型认可，但仍有三个 P0，未签字 |

已认可、不要重新推翻的方向：

- 模型名称：`new session per completed playback cycle`；
- 新 session ID：`pb:<stageId>:<visitId>`；
- visitId 为 16-byte/32-hex 随机 ID；
- create 永远 `active`；
- 完成链顺序为 `create(active) → append → set_status(completed)`；
- `PlaybackVisit` 使用 visitId 单一主键；
- Dexie v18 新增 `playbackVisits` 与 `playbackVisitStates`，保留旧 `playbackState`；
- createEntryId 与 completedStatusEntryId 持久化；
- snapshot/state/outbox/chain 在同一 Dexie 事务；
- `INACTIVE_SESSION` 必须在 R3.0 中央响应处理，不在 playback 外围重复消费 Response；
- dead telemetry 推迟到 diagnostics 契约卡；
- Production 在真实 E2E 重新通过前保持 NO-GO。

---

## 6. v0.5 剩余三个 P0（下一位评审者的首要任务）

### P0-1：BroadcastChannel claim 伪代码必然失效

文件中的两个问题：

1. sessionStorage 已有 ownerId 时直接返回，复制标签页不会进行碰撞检测；
2. `while (Date.now() - start < 100)` 阻塞事件循环，等待期间不可能收到 `onmessage`。

必须修为异步协议：

- `claimTabOwnerId(): Promise<string>`；
- 即使 sessionStorage 已有 ID，也必须 ping；
- 使用 Promise + timer 等待响应，严禁 busy-wait；
- 每个 document 有内存 instanceId；
- owner 冲突时以 instanceId 稳定排序决定哪一方保留，另一方轮换，避免双方同时放弃；
- F5 时旧 document 已退出，因此新 document 可复用原 owner；
- 复制标签页时原 document 存活，复制页必须轮换。

应补门禁：两个实例同时启动且持有相同复制 ownerId，最终恰好一个保留原 owner，另一个获得新 owner。

### P0-2：重复 complete 的依赖方向与 preflight 顺序错误

当前 v0.5 用 `where('dependsOnEntryId').equals(completedStatusEntryId)` 查 append，但真实关系是：

```text
statusEntry.dependsOnEntryId = appendEntryId
```

还存在更严重的顺序问题：完整流程先入队新 append，之后才检查是否已有 completedStatusEntryId。即使 eventId 相同，新 append 也会留下，并在 session completed 后收到 409。

必须在写 state、入队 append 之前执行 preflight：

- status 仍在 outbox：从 statusEntry.dependsOnEntryId 读取旧 append 并比较 eventId；
- status 已存在于 succeededEntries：cycle 已完成，下一有效动作必须创建新 visit；
- eventId 相同且 status 未完成：零新入队，返回既有 append/status IDs；
- eventId 不同且 status 未完成：在任何写入前拒绝；
- E2E/单测必须断言重复 complete 后 runtimeOutbox 条目数不增加。

### P0-3：Legacy adoption 查询和调用链未接通

当前 schema 没有单字段 `stageId` 索引，但 adoption 使用 `where('stageId')`，会在 Dexie 运行时报错。

修正要求：

- 使用已有 `[stageId+status]` 索引，或显式新增 `stageId` 索引；
- `claimOrReuseVisitInTx()` 的第一步必须调用 `adoptLegacyVisitInTx()`；
- legacy session identity 必须保持 `pb:<stageId>`；
- 未完成 legacy visit 仅允许第一个标签页原子接管；
- completed 但无成功凭据的 legacy 行不得作为 active cycle 恢复；
- adoption 失败/已被接管时，当前标签页创建新的正常 visit。

---

## 7. 建议的下一步

让文档作者只提交一个小型 `v0.5.1` 勘误，不再重写整份设计：

1. 修正异步 owner claim；
2. 把 duplicate-complete preflight 移到所有写入之前，修正依赖方向；
3. 把 legacy adoption 接入 claim 流程并改用合法索引；
4. 补对应三个门禁；
5. 保持“未实施代码”状态。

下一位评审者应先逐行核对上述三点。三点全部闭合且没有引入新状态机矛盾后，可以签署 **R3.1a 设计**，但签字范围只允许进入实现评审，不包含：

- Production；
- 环境变量；
- SQL；
- R3.x；
- diagnostics 修复；
- legacy 数据实际清理。

签字后的实施顺序建议：

1. 先单独修订并测试 R3.0 中央 `INACTIVE_SESSION` 分类；
2. 再实现 Dexie v18、cycle identity 与 visit-specific state；
3. 跑单元/回归门禁；
4. 最后由具备浏览器权限的工具执行真实 Preview E2E；
5. 完成课程 → 重入 → 播放/切场景必须无 409，且 outbox 最终排空；
6. 通过后再重新制作 Production 决策卡。

---

## 8. 后续两张尚未开始的设计卡

R3.1a 签字之后，仍需继续：

1. `client-diagnostics` 400 契约调查与门禁测试设计；
2. 修复前旧 outbox 条目一次性终结方案。

注意：第二项是浏览器 Dexie 状态，不是 Supabase 业务表清理。必须按 kind、版本和结构化 errorCode 精确识别，不得批量删除正常 pending。

---

## 9. 新模型开始工作时的最小读取清单

按顺序读取：

1. 本交接文档；
2. `docs/reports/2026-08-05-r3-preview-regression-observation.md`；
3. `docs/reports/2026-08-05-r3.1a-playback-visit-session-design.md`；
4. `lib/runtime/outbox.ts`；
5. `lib/runtime/playback-outbox.ts`；
6. `lib/utils/playback-persistence.ts`；
7. `lib/utils/database.ts`；
8. `tests/playback/playback-outbox.test.ts`。

不要仅根据作者的修订摘要签字；必须检查伪代码的查询索引、依赖方向、事务表集合、Response 消费方式和重复调用行为。

---

## 10. 当前交接结论

```text
R3.0 code                         SIGNED
R3.1 playback code               SIGNED（但跨 cycle P0 待 R3.1a）
R3.2 quiz code + Preview E2E     SIGNED
R3.1a design v0.5                REVIEW BLOCKED（三个 P0）
Production                       NO-GO
R3.x dual-read                   FORBIDDEN
SQL / env / Production changes   NOT AUTHORIZED
```
