# Quiz Outbox 原子幂等入队与单调链尾修复实施报告

- 日期：2026-08-21
- 分支：`fix/r3-quiz-outbox-concurrency`
- 基线：`test/r3-upstream-regression-gates` HEAD `cbd216b69dec23add0ffee32c2c52ac986d84463`
- 修改生产文件：`lib/runtime/quiz-outbox.ts`
- Schema version changed：否
- 状态：REVIEW REQUESTED

---

## 1. 根因

`quizSubmittedViaOutbox` 每次调用都无条件执行三步：

1. `_qEnqueue` 创建一条 `quiz:create:<sessionId>`；
2. `_qEnqueue` 创建一条 `quiz:submit:<sessionId>`（依赖 create）；
3. `_setTailInTx(sessionId, submitId)` 无条件覆盖 chain head。

其中 `_qEnqueue` 的"去重"是 **supersede 旧条目 + 新建新条目**，而非幂等复用。因此：

- **Q2.5（刷新重复 submitted）**：第二次调用把第一次的 pending create/submit 标记为 `superseded` 并新建一套，导致 `quiz:create` / `quiz:submit` 各出现 > 1 条。
- **Q4.1 / Q4.7（跨标签页并发 submitted）**：多个并发 rw 事务串行化后，每个后续事务都能读到前一个事务留下的 pending 条目并将其 supersede + 新建，最终残留多条 create/submit。
- **Q4.6（chain head 回退）**：`_setTailInTx` 无条件把 head 指回新的 submit，即使 head 已经推进到 reviewed/completed。

核心不变量被破坏：**同一个 attempt 应只拥有一套 create/submitted 链，head 只能前进不能回退。**

## 2. 修复前事务时序

```
quizSubmittedViaOutbox (每次调用独立 rw 事务，无幂等判定)
  ├─ _qEnqueue(create)
  │    └─ 查 semanticKey 的 pending 旧条目 → supersede 旧 + 新建新
  ├─ _qEnqueue(submit, depends=create)
  │    └─ 同样 supersede + 新建
  └─ _setTailInTx(sessionId, submitId)   // 无条件覆盖 head
```

并发下：事务 A 提交 create_A/submit_A → 事务 B 读到 create_A/submit_A（pending）→ supersede 后新建 create_B/submit_B → head 被回退到 submit_B。

## 3. 修复后事务时序

```
quizSubmittedViaOutbox (单个 rw 事务，覆盖 runtimeOutbox + runtimeChainHeads + succeededEntries)
  ├─ 读 session 全部 entries
  ├─ 读 chain head
  ├─ 读 succeededEntries（entryId 集合）
  ├─ 幂等分类（按序短路，见 §4）
  │     ├─ E：active submit payload 漂移 → 抛 QuizSubmissionMismatchError（最先检查，即使后续阶段已入队）
  │     ├─ B：active create+submit 且 payload/dependency 一致 → 复用现有 ID，零写入
  │     ├─ D：已进入后续阶段 → 幂等空转，head 不回退
  │     ├─ F：已 dead → 抛 QuizSubmissionBlockedError
  │     ├─ F'：孤立 superseded → 抛 QuizSubmissionBlockedError
  │     ├─ C：已成功 → 幂等空转
  │     ├─ G：异常部分状态 → 抛 QuizSubmissionCorruptError
  │     └─ A：全新 → 同事务 _qEnqueueRaw(create) + _qEnqueueRaw(submit, depends=create) + setTail(submit)
  └─ 返回最终 entry ID / 幂等结果
```

`_qEnqueueRaw` 是**纯净入队**：不 supersede、不去重，幂等判定完全上移到调用方事务内完成。sequence 取事务内 entries 最大值 +1，避免 superseded/dead 行占位产生间隙。

## 4. 状态 A–G 实际处理

分类按「短路顺序」列出：**E → B → D → F → F' → C → G → A**。

| 状态 | 判定条件 | 行为 |
|---|---|---|
| E 相同 attempt 不同 payload | active submit 存在，canonical body 不一致 | 抛 `QuizSubmissionMismatchError`，事务零写入。**最先检查**：即使 reviewed/completed 已入队，payload 漂移也必须抛错而非落入 D 空转 |
| B 相同提交 pending/sending | active create 与 active submit 存在，canonical body 一致，且 `submit.dependsOnEntryId === create.id` | 复用现有 entry ID，不新建、不 supersede、不增 sequence、不改 lease、不回写 head |
| D chain 已进入后续阶段 | head 为 reviewed/completed/archived，或存在 active 的后续阶段 | 幂等空转，head 不回退，不 supersede 后续 |
| F create/submit 已 dead | 存在 dead 的 create/submit | 抛 `QuizSubmissionBlockedError`，不重建 |
| F' 孤立 superseded | 存在 superseded 的 create/submit，且无 active successor、无成功凭据、无后续链 | 抛 `QuizSubmissionBlockedError`，禁止同 attempt 重建 |
| C create/submit 已成功 | 无 active create/submit，head 指向的 entry 已持有 succeededEntries 凭据 | 幂等空转，返回幂等结果 |
| G 异常部分状态 | 有 submit 无 create / 有 create 无 submit / create-submit dependency 不一致 / head 指向不存在 entry 且无成功凭据 | 抛 `QuizSubmissionCorruptError`，不猜测、不拼接 |
| A 全新 attempt | 无 active create、无 active submit、无 dead、无孤立 superseded、无成功凭据、无 head | 同事务建 create + submit，head 指向 submit |

## 5. canonical payload 规则

- 参与比较的业务字段：`sceneId`、`payload.phase`、`payload.answers`。
- **不参与比较**：`createdAt`（客户端生成时间）、`id`（由 sessionId 唯一决定，sessionId 相同则 id 相同）。
- 比较前经 `stableStringify` 递归处理：对象 key 排序，数组保持顺序，使「key 顺序不同但 JSON 语义相同」的对象得到相同字符串。
- 客户端生成时间不同不会使相同 envelope 被误判为不同提交。
- 未引入新的加密或安全声明；未复用项目已有 hash 工具（当前无适用的 canonical/hash 工具可直接复用）。

## 6. chain head 单调规则

- phase 顺序：`create(0) → submit(1) → reviewed(2) → completed(3) → archived(4)`，由 `quizPhaseOf` 从 semanticKey 前缀识别。
- 空链可指向 submit；submit → reviewed；reviewed → completed；completed → archived。
- 后续阶段不能被 submitted 覆盖：状态 D 直接短路，不回写 head。
- 并发事务中较旧阶段不能覆盖较新阶段：入队只在「无 active create/submit 且无 head」的状态 A 发生，其余状态零写入。
- 刷新重入不重置 head：head 由 Dexie 持久化，入队不覆盖已有 head。
- dead/superseded 不被当作正常新链尾：dead → 抛错；superseded 有明确 successor 时按 B/D/C 处理，孤立 superseded 命中 F′。
- 未按 `updatedAt` 判断更新，全部按真实 entry 的 phase/dependency 判断单调性。

## 7. Q2.5 / Q4.1 / Q4.6 / Q4.7 转绿证据

修复前四个测试均为 `it.fails`（4 expected fail，vitest 输出 `27 passed | 4 expected fail`）。

修复后改为普通 `it`，全部通过：

```
✓ Q2.5 刷新后未发送条目不得生成第二条等价 create/submitted
✓ Q4.1 同时提交相同 envelope 只产生一条 create
✓ Q4.6 chain head 不回退
✓ Q4.7 不产生两个不同 create session
```

`tests/quiz/quiz-outbox-recovery-regression.test.ts` + `tests/quiz/quiz-outbox-cross-tab.test.ts` 合计 **31 passed (31)**，无 expected fail。

## 8. 新增 QC1–QC12 结果

`tests/quiz/quiz-outbox-atomic-idempotency.test.ts`（12 tests 全部通过）：

| 门禁 | 结果 |
|---|---|
| QC1 两标签页同时 submitted 只产生一套 create/submitted | PASS |
| QC2 三标签页竞争仍只有一套，sequence 无间隙无垃圾 | PASS |
| QC3 pending/sending 期间重入不生成第二套且不抢 lease | PASS |
| QC4 成功后重入零入队且成功凭据不变 | PASS |
| QC5 后续阶段后重入不改变 outbox 且 head 保持 | PASS |
| QC6 payload mismatch 抛领域错误且事务零写入 | PASS |
| QC7 事务回滚时 create/submitted/head 全不提交 | PASS |
| QC8 刷新恢复后仍复用原 entry | PASS |
| QC9 后续阶段已入队时 payload mismatch 仍抛 mismatch | PASS |
| QC10 create/submit dependency 不一致抛 corrupt 且零写入 | PASS |
| QC11 create/submit 已 dead 时再次 submitted 抛 blocked | PASS |
| QC12 孤立 superseded create/submit 禁止同 attempt 重建 | PASS |

## 9. 全部回归结果

分目录运行（vitest 在管道/TTY 下会偶发 SIGPIPE 退出，改为重定向到文件统计）：

```
tests/quiz              97 passed (97)
tests/runtime-outbox    39 passed (39)
tests/playback          93 passed (93)
tests/runtime-shadow    40 passed | 5 expected fail | 1 skipped (46)
─────────────────────────────────────────────────────
合计                    269 passed | 5 expected fail | 1 skipped (275)
```

- Quiz expected fail：**4 → 0**（转绿 + 无新增 expected fail）。
- Chat expected fail：**5**（保持原状，未改动 Chat）。
- Chat skipped：**1**（C1.1 testability 缺口，保持原状）。
- Playback：24 项 visit-regression 全部通过，无回归。
- TypeScript：`0 errors`。
- Unhandled rejection：`0`。

## 10. 未修改声明

- 未修改服务端 Runtime API 契约。
- 未修改 Supabase / SQL。
- 未修改 Vercel 配置或任何环境变量。
- 未部署 Preview / Production。
- 未修改数据库 schema/version（仍为 v18）。
- 未修改 `lib/runtime/outbox.ts`（通用 R3.0 状态机）、Playback、Chat。

## 11. 是否影响 Production

否。本任务仅修改 `lib/runtime/quiz-outbox.ts` 的入队逻辑，Quiz shadow 仍受
`NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ === '1'` 子开关门禁，未启用 Production Quiz。

## 12. 已知边界

- `quizReviewedViaOutbox` / `quizRetryViaOutbox` 仍沿用旧 `_qEnqueue`（supersede 语义）。本任务范围仅限 submitted 幂等，未扩展 reviewed/retry 的幂等。若未来需要 reviewed/retry 的并发幂等，需另案评估。
- 状态 C 的判断依赖「head 指向的 entry 已持有 succeededEntries 凭据」这一事实：outbox 严格依赖链保证 head 成功后其全部前置（含 create/submit）必已成功。此依赖关系由 R3.0 依赖链保证，未在本任务中单独重建。
- `succeededEntries` 仅存 `entryId`，不含 semanticKey，无法反查某条成功凭据对应哪个 phase；状态 C 因此通过 head 而非语义反查实现，这是当前 schema 约束下的正确做法，若未来需要更细粒度反查需扩展 schema。
- **成功后的 payload 漂移 not_observable**：当 submitted 已成功并从 outbox 删除后，`succeededEntries` 只有 `entryId`、无原 payload 指纹，客户端在「成功后的同 attempt payload 漂移」场景下**无法比较**（此时 activeSubmit 已不存在，E 检查无从触发，落入 C/D 空转）。这是当前 schema 下的 `not_observable` 边界，未在本卡升级 schema；若需观测，须另案持久化 submission fingerprint（如 `succeededEntries` 增列或语义键反查），并需单独授权。
