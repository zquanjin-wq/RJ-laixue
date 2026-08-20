# OpenMAIC v0.3.2 启发的本地 Runtime 回归门禁报告

- 完成日期：2026-08-20
- 分支：`test/r3-upstream-regression-gates`
- 基线 commit：`4579519bfb66a19824584119bdceb45f916bbfe9`（`test/r3-line`）
- 审计报告：`docs/reports/2026-08-18-openmaic-v032-runtime-persistence-audit.md`
- 性质：只新增测试，不修改生产代码、SQL、环境变量，不部署
- 状态：REVIEW REQUESTED

---

## 1. 基线与范围

本次任务从 `test/r3-line` HEAD `4579519bfb66a19824584119bdceb45f916bbfe9` 创建独立分支 `test/r3-upstream-regression-gates`，仅新增回归门禁测试与报告。

新增测试文件：

- `tests/playback/playback-visit-regression.test.ts`
- `tests/quiz/quiz-outbox-recovery-regression.test.ts`
- `tests/quiz/quiz-outbox-cross-tab.test.ts`
- `tests/runtime-shadow/chat-shadow-concurrency-repro.test.ts`

未修改任何产品代码（`lib/`、`app/`、`components/`、`packages/`、SQL、环境变量、schema）。

---

## 2. 测试真实性声明

测试中使用了以下真实本地实现：

- `lib/runtime/playback-visit.ts`：`persistSnapshotWithComplete`、`checkVisitCompleted`
- `lib/runtime/playback-outbox.ts`：`drainPlaybackOutbox`、`shadowPlaybackProgressViaOutbox`
- `lib/runtime/quiz-outbox.ts`：`quizSubmittedViaOutbox`、`quizReviewedViaOutbox`、`quizRetryViaOutbox`、`drainQuizOutbox`、`resolveQuizEffectiveTime`
- `lib/runtime/outbox.ts`：`scanAndDrain`、`cleanupExpiredLeases`、`enqueue`、`dequeueOne`
- `lib/runtime/shadow-writer.ts`：`shadowChatSessions`
- `lib/utils/database.ts`：`db`（Dexie 表：`runtimeOutbox`、`succeededEntries`、`runtimeChainHeads`、`playbackVisits`、`playbackVisitStates`、`playbackState`）

仅 mock 了 `fetch`、时间（通过改写 `nextAttemptAt`）、`localStorage`、`sessionStorage`、`BroadcastChannel`、`crypto.randomUUID`。

---

## 3. Playback 门禁结果

| 门禁 | 结果 | 关键证据 |
|---|---|---|
| P1.1 首播创建 `pb:<stageId>:<visitId-A>` | PASS | `playback-visit-regression.test.ts:58` |
| P1.2 F5/同一未完成周期复用 `visitId-A` | PASS | `playback-visit-regression.test.ts:67` |
| P1.3 completed 凭据成功后重新进入创建 `visitId-B` | PASS | `playback-visit-regression.test.ts:76` |
| P1.4 `visitId-B` 不得依赖 `visitId-A` 的 outbox entry | PASS | `playback-visit-regression.test.ts:88` |
| P1.5 不得向 completed 的旧 session 追加 record | PASS | `playback-visit-regression.test.ts:102` |
| P2.1 snapshot completed=true 但无 succeededEntries 凭据不算完成 | PASS | `playback-visit-regression.test.ts:120` |
| P2.2 status entry 凭据写入 succeededEntries 后才翻转 visit | PASS | `playback-visit-regression.test.ts:131` |
| P2.3 status dead/pending/sending/superseded 不能被当作完成 | PASS | `playback-visit-regression.test.ts:142` |
| P2.4 重复检查幂等 | PASS | `playback-visit-regression.test.ts:153` |
| P3.1 新 visit 入队不复用旧 session ID `pb:<stageId>` | PASS | `playback-visit-regression.test.ts:169` |
| P3.2 旧迁移条目不能覆盖新 visit state | PASS | `playback-visit-regression.test.ts:184` |
| P3.3 新 visit compaction 不 supersede 旧 session 条目 | PASS | `playback-visit-regression.test.ts:202` |
| P3.4 旧 session 成功凭据不能完成新 visit | PASS | `playback-visit-regression.test.ts:220` |
| P3.5 drain 后两条 session dependency chain 不交叉 | PASS | `playback-visit-regression.test.ts:237` |
| P4.1 符合条件的 legacy 行只被 adopt 一次 | PASS | `playback-visit-regression.test.ts:259` |
| P4.2 adoption 保持原 session ID `pb:<stageId>` | PASS | `playback-visit-regression.test.ts:270` |
| P4.3 adopt 后清除 `isLegacyAdopted` | PASS | `playback-visit-regression.test.ts:281` |
| P4.4 已 adopt 行再次进入不会重复创建新 visit | PASS | `playback-visit-regression.test.ts:292` |
| P4.5 legacy completed session 不得被当成 active 新周期 | PASS | `playback-visit-regression.test.ts:306` |
| P5.1 页面刷新后未发送 outbox 保留 | PASS | `playback-visit-regression.test.ts:322` |
| P5.2 expired lease 被回收后新 tab 可 claim | PASS | `playback-visit-regression.test.ts:335` |
| P5.3 网络失败后进入 pending 和退避 | PASS | `playback-visit-regression.test.ts:349` |
| P5.4 online 后从阻断根继续 | PASS | `playback-visit-regression.test.ts:362` |
| P5.5 旧请求晚成功不能清除新 pending | PASS | `playback-visit-regression.test.ts:381` |

---

## 4. Quiz 门禁结果

| 门禁 | 结果 | 关键证据 |
|---|---|---|
| Q1.1 每个 entry `dependsOnEntryId` 精确指向前一项 | PASS | `quiz-outbox-recovery-regression.test.ts:47` |
| Q1.2 `runtimeChainHeads.tailEntryId` 始终指向真实链尾 | PASS | `quiz-outbox-recovery-regression.test.ts:59` |
| Q1.3 不允许 reviewed 绕过 submitted | PASS | `quiz-outbox-recovery-regression.test.ts:82` |
| Q1.4 不允许 completed 早于 reviewed | PASS | `quiz-outbox-recovery-regression.test.ts:95` |
| Q1.5 不允许 archived 早于 completed | PASS | `quiz-outbox-recovery-regression.test.ts:108` |
| Q1.6 同一 session 内 sequence 单调递增 | PASS | `quiz-outbox-recovery-regression.test.ts:123` |
| Q2.1 localStorage 提交 envelope 保留 | PASS | `quiz-outbox-recovery-regression.test.ts:145` |
| Q2.2 runtimeOutbox 保留 | PASS | `quiz-outbox-recovery-regression.test.ts:155` |
| Q2.3 runtimeChainHeads 保留 | PASS | `quiz-outbox-recovery-regression.test.ts:165` |
| Q2.4 succeededEntries 保留 | PASS | `quiz-outbox-recovery-regression.test.ts:176` |
| Q2.5 刷新后未发送条目不得生成第二条等价 create/submitted | EXPECTED_FAIL_CONFIRMED | `quiz-outbox-recovery-regression.test.ts:187` |
| Q2.6 重试必须沿用已有 entry ID 与依赖关系 | PASS | `quiz-outbox-recovery-regression.test.ts:207` |
| Q2.7 已成功 entry 不得复活 | PASS | `quiz-outbox-recovery-regression.test.ts:222` |
| Q3.1 入队时离线不会丢数据 | PASS | `quiz-outbox-recovery-regression.test.ts:241` |
| Q3.2 fetch 失败后进入 pending 和退避 | PASS | `quiz-outbox-recovery-regression.test.ts:251` |
| Q3.3 scheduler 按阻断根 entry 的 `nextAttemptAt` 唤醒 | PASS | `quiz-outbox-recovery-regression.test.ts:271` |
| Q3.4 三段以上依赖链不得每秒空转 | PASS | `quiz-outbox-recovery-regression.test.ts:291` |
| Q3.5 online 后从阻断根继续 | PASS | `quiz-outbox-recovery-regression.test.ts:316` |
| Q3.6 成功后顺序排空 | PASS | `quiz-outbox-recovery-regression.test.ts:333` |
| Q4.1 同时提交相同 envelope 只产生一条 create | EXPECTED_FAIL_CONFIRMED | `quiz-outbox-cross-tab.test.ts:47` |
| Q4.2 同时 drain 时 lease 只能由一个 owner 获得 | PASS | `quiz-outbox-cross-tab.test.ts:66` |
| Q4.3 lease 未过期时另一 owner 不得发送 | PASS | `quiz-outbox-cross-tab.test.ts:88` |
| Q4.4 lease 过期后允许安全接管 | PASS | `quiz-outbox-cross-tab.test.ts:108` |
| Q4.5 成功凭据只写一次 | PASS | `quiz-outbox-cross-tab.test.ts:127` |
| Q4.6 chain head 不回退 | EXPECTED_FAIL_CONFIRMED | `quiz-outbox-cross-tab.test.ts:142` |
| Q4.7 不产生两个不同 create session | EXPECTED_FAIL_CONFIRMED | `quiz-outbox-cross-tab.test.ts:162` |
| Q5.1 submitted dead 时 reviewed/completed/archived 全部 dead | PASS | `quiz-outbox-cross-tab.test.ts:179` |
| Q5.2 reviewed dead 时 completed/archived dead | PASS | `quiz-outbox-cross-tab.test.ts:198` |
| Q5.3 superseded 前置项按规则处理后依赖者不悬挂 | PASS | `quiz-outbox-cross-tab.test.ts:217` |
| Q5.4 dead 依赖者不会因为 succeededEntries GC 或刷新而复活 | PASS | `quiz-outbox-cross-tab.test.ts:236` |
| Q5.5 runtimeChainHeads 不得指向不存在且无法解释的 entry | PASS | `quiz-outbox-cross-tab.test.ts:255` |

---

## 5. Chat 并发窗口门禁结果

| 门禁 | 结果 | 关键证据 |
|---|---|---|
| C1.1 两次并发 shadowChatSessions 读到同一旧 cursor 并发送不同 payload | BLOCKED_BY_TESTABILITY | `chat-shadow-concurrency-repro.test.ts:52`（使用 `it.skip` 移出可执行统计；在 JS 单线程事件循环下无法稳定控制时序） |
| C1.2 相同 session + message.id 生成相同 record ID | PASS | `chat-shadow-concurrency-repro.test.ts:103` |
| C1.3 遇到 409 IDEMPOTENCY_CONFLICT 时 cursor 仍前进 | PASS | `chat-shadow-concurrency-repro.test.ts:124` |
| C1.4 cursor 最终指向前进位置 | PASS | `chat-shadow-concurrency-repro.test.ts:140` |
| C2.1 相同 record ID + 相同 payload 应视为合法幂等重复 | PASS | `chat-shadow-concurrency-repro.test.ts:160`（重置 cursor 强制产生两次真实 `/records` 请求，两次 ID 与 payload 相同，均按 201 处理） |
| C2.2 相同 record ID + 不同 payload 应识别为 payload 漂移 | EXPECTED_FAIL_CONFIRMED | `chat-shadow-concurrency-repro.test.ts:177` |
| C2.3 当前实现不能将 payload 漂移与普通重试区分 | EXPECTED_FAIL_CONFIRMED | `chat-shadow-concurrency-repro.test.ts:202` |
| C3.1 Session A 的游标推进不影响 Session B | PASS | `chat-shadow-concurrency-repro.test.ts:229` |
| C3.2 Session A 的失败不阻断 Session B | PASS | `chat-shadow-concurrency-repro.test.ts:242` |
| C3.3 不同 session 之间不得复用 record ID | PASS | `chat-shadow-concurrency-repro.test.ts:269` |
| C4.1 当前实现无法可靠判断 assistant message 是否 finalized | EXPECTED_FAIL_CONFIRMED | `chat-shadow-concurrency-repro.test.ts:293` |
| C4.2 仅通过再次保存或 content 变化不能形成不可变记录 | EXPECTED_FAIL_CONFIRMED | `chat-shadow-concurrency-repro.test.ts:309` |
| C4.3 单纯增加 finalized 字段仍不足以关闭旧游标并发窗口 | EXPECTED_FAIL_CONFIRMED | `chat-shadow-concurrency-repro.test.ts:330` |

---

## 6. 汇总

| 分类 | 数量 |
|---|---|
| PASS | 57 |
| EXPECTED_FAIL_CONFIRMED | 9 |
| NEW_GAP | 0 |
| BLOCKED_BY_TESTABILITY | 1 |
| NOT_APPLICABLE | 0 |

- 0 个 unhandled rejection
- 0 个由测试基建造成的假绿
- 0 个生产代码改动
- 0 个新增 TypeScript 错误
- 工作树除 `.workbuddy/` 元数据外无无关改动

---

## 7. Chat 并发时序与真实请求证据

C2.1 强制产生两次真实 `/records` 请求验证幂等路径：

1. 第一次 `shadowChatSessions` 成功发送 `cs-idempotent:m1`，payload 为 `"canonical"`，cursor 前进到 1；
2. 将 `rshadow:chat:cs-idempotent` 回退到 `{"count":0}`，模拟旧游标重读；
3. 第二次调用读取旧游标并再次发送 `/records`；
4. 两次请求 record ID 相同（`cs-idempotent:m1`），payload 相同（`"canonical"`），均按 201 处理，cursor 最终为 1。

C2.2 复现了旧游标回退后的 payload 漂移：

1. 第一次 `shadowChatSessions` 成功发送 `cs-drift:m1`，payload 为 `"hello"`，cursor 前进到 1；
2. 模拟并发/刷新损坏，将 `rshadow:chat:cs-drift` 回退到 `{"count":0}`；
3. 第二次调用时 content 已变为 `"world"`，本地实现读取旧游标并再次发送 `/records`，payload 为 `"world"`；
4. 同一 record ID `cs-drift:m1` 对应两个不同 payload。

C2.3 复现了 IDEMPOTENCY_CONFLICT 的误判：

1. 第一次发送成功；
2. 回退游标后第二次发送，服务端返回 409 `IDEMPOTENCY_CONFLICT`；
3. 本地实现未校验 payload，直接将 cursor 前进到 1，把 payload 漂移当成普通幂等重复。

C4.3 通过构造 create_session 挂起的并发场景说明：即使假设存在 `finalized` 字段，只要 cursor 不是原子读取-推进，第二次调用仍可能在第一次写 cursor 前读到旧游标。

---

## 8. Testability 缺口

C1.1 被标记为 BLOCKED_BY_TESTABILITY，并使用 `it.skip` 从可执行测试统计中移除：在不修改生产代码的前提下，无法在 JS 单线程事件循环中稳定让第二次 `shadowChatSessions` 调用在第一次写 cursor 之前读到旧游标。代码路径存在该窗口，但测试无法以 100% 概率复现。后续若需稳定复现，需单独授权增加生产代码 seam（如暴露 cursor 读取-推进锁或 outbox 串行化队列）。

---

## 9. 是否发现影响 Production shadow 的新 P0

否。本次回归门禁确认：

- Playback visit-session 生命周期符合 R3.1a 签字设计；
- Quiz outbox 严格顺序、dead 级联、恢复路径正常；
- Chat 并发旧游标/payload 漂移是已知 shadow-only 限制，未触发数据丢失或读源切换；
- 未发现需要立即回滚 Production shadow 的新 P0。

---

## 10. 建议的后续修复卡

### 卡 1：Quiz outbox 并发入队幂等性

- **目标**：修复 `quizSubmittedViaOutbox` 并发调用时可能产生多个 create/submit 的问题（Q2.5/Q4.1/Q4.7）。
- **范围**：仅 `lib/runtime/quiz-outbox.ts` 的 `_qEnqueue` 与入队事务；
- **明确不做**：不改服务端契约、不改 Quiz 状态机；
- **验收门禁**：Q2.5/Q4.1/Q4.7 转为 PASS；现有 Quiz 测试全绿；
- **是否影响 Production**：否（shadow-only）；
- **是否需要单独授权**：是（涉及 outbox 事务语义变更）。

### 卡 2：Quiz chain head 不回退

- **目标**：修复重复 `quizSubmittedViaOutbox` 调用将 `runtimeChainHeads.tailEntryId` 回退到新 submit entry 的问题（Q4.6）。
- **范围**：`lib/runtime/quiz-outbox.ts` 的 `_setTailInTx` 调用点；
- **明确不做**：不改链顺序、不改恢复语义；
- **验收门禁**：Q4.6 转为 PASS；
- **是否影响 Production**：否；
- **是否需要单独授权**：是。

### 卡 3：Chat shadow 串行化与 payload 不可变性

- **目标**：为 Chat shadow 增加 per-session 串行化或原子 cursor/outbox，关闭旧游标并发窗口与 payload 漂移窗口（C1/C2/C4）。
- **范围**：`lib/runtime/shadow-writer.ts` 的 chat 路径；
- **明确不做**：不解除 Chat shadow-only、不改服务端契约、不实施 dual-read；
- **验收门禁**：C1.1 可稳定复现为 EXPECTED_FAIL_CONFIRMED 或 PASS；C2.2/C2.3/C4.x 全部 PASS；
- **是否影响 Production**：否（shadow-only）；
- **是否需要单独授权**：是（Codex 评审与负责人拍板）。

---

## 11. 完成汇报

- Branch：`test/r3-upstream-regression-gates`
- Base commit：`4579519bfb66a19824584119bdceb45f916bbfe9`
- 新增测试 commit：`a2b814c5298ee0d2f0b2235d42b29c9ee5bbd6af`
- 报告 commit：本文件所在 commit（提交后生成）
- Report：`docs/reports/2026-08-19-openmaic-v032-runtime-regression-gates.md`
- Production files changed：否
- Playback：PASS 24 / EXPECTED_FAIL 0 / NEW_GAP 0 / BLOCKED 0
- Quiz：PASS 26 / EXPECTED_FAIL 4 / NEW_GAP 0 / BLOCKED 0
- Chat：PASS 7 / EXPECTED_FAIL 5 / NEW_GAP 0 / BLOCKED_BY_TESTABILITY 1
- 新增专项汇总：PASS 57 / EXPECTED_FAIL 9 / BLOCKED 1（共 68 项，含 1 个 skipped）
- 全部相关目录回归：16 files, 253 passed / 9 expected fail / 1 skipped（共 263 tests）
- TypeScript：0 errors
- Unhandled rejection：0
- 是否发现影响 Production shadow 的新 P0：否
- 是否执行 SQL/部署/环境变量操作：否
- Worktree：除 `.workbuddy/` 元数据外干净
- 推荐下一任务：卡 1「Quiz outbox 并发入队幂等性」

状态：**REVIEW REQUESTED**
