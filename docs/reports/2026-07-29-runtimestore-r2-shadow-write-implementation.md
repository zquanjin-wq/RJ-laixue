# R2 影子双写实施报告 — RuntimeStore shadow write

- 日期：2026-07-29（v2 修订：2026-07-30，Codex 验收卡三项处置已落实）
- 实施：Kimi K3
- Commit：`5e6c1366` feat(runtime): R2 shadow write（初版）→ 验收卡修订见 v2 commit（下方）
- 前置：R2 设计稿 v2.1（`692cf9b7` + 勘误）；R1.1 服务端基础设施（`52862d2e` 签字收官）

> **v2 修订说明（2026-07-30，Codex 验收卡：暂不签字 → 条件不通过 → 三项处置）：**
> 1. **quizAttempt 原子性 P0 修复**：初版报告 §3 宣称的「两个 setItem 天然原子」
>    **是错误声明**——`setItem(attemptId)` 与 `setItem(answers)` 不具备跨键原子性，
>    第二次失败会留下孤立 attemptId。已按修复卡改为**单键提交 envelope**
>    （`quizAnswers:<sceneId>` = `{v, attemptId, answers}`，一次 setItem 原子写入）；
>    影子路径只认持久化读回的 envelope（`readSubmittedEnvelope`），写失败/legacy
>    裸 answers 时读不到即跳过，**禁止使用调用方内存数据**。§3 P0-2、§5 已改正。
> 2. **playback 移出 R2**（Codex 拍板）：初版 §4-② 的处置不被认可——eventId 只在
>    单次函数调用内复用、Dexie 无读回路径、测试未覆盖刷新恢复，不满足
>    「任何重试/刷新/跨标签页恢复都取回同一个 id」硬门禁；补恢复实质是建设
>    pending/outbox，与 R2 排除 outbox 冲突。playback 全部改动（影子函数、
>    PlaybackChromeRoot 挂点、PlaybackSnapshot/PlaybackStateRecord 字段、测试）
>    **已撤销**，另立 R2.1/R3 前置卡。§3 P0-1、§4-② 已改正。
> 3. **设计稿勘误**：phase 枚举 `submitted`/`reviewed`（Codex 认可实施，仅修订文档）。
>
> 下文为初版报告，§3/§4/§5/§6 已按上述处置就地改正；其余章节保留原貌。

---

## 1. 授权边界逐条对照

| 授权边界 | 落实情况 |
|---|---|
| 只做影子写 | ✅ 全部写入走 `/api/runtime/v1/*`，不触碰任何本地读路径 |
| 默认关闭 | ✅ `NEXT_PUBLIC_RUNTIME_SHADOW === '1'` 才启用；关闭时所有入口立即返回，**零 fetch、零 Dexie/localStorage 写**（有测试断言） |
| 本地读源零改动 | ✅ chat/quiz/playback 三个读路径（loadChatSessions / readSubmittedState / loadPlaybackState）未改一行；playbackState 表至今无读取方，影子开启后的本地写不改变任何读取行为 |
| 不执行任何 Supabase SQL | ✅ 零迁移、零 SQL |
| 不开 Preview/生产开关 | ✅ 仅 .env.example 加注释文档，未在任何环境设置该变量 |
| 不接 redeem merge-grant | ✅ 未触碰 |
| 不接匿名写 | ✅ R2 只覆盖 auth.uid() 已登录用户（runtime API 服务端强制） |
| 不接 outbox | ✅ 失败即丢弃（fire-and-forget），仅内存重试 ≤2 次 |
| 不接双读/读源切换 | ✅ 未触碰 |
| runtimeShadowEventId 与 quiz attemptId 与原数据同一次本地写入持久化 | ✅ quiz：单键 envelope 原子写（v2 修订）；playback：已移出 R2 |
| 测试覆盖刷新后重试仍复用同一 ID | ✅ 见 §5（含写失败注入/跨标签页，v2 新增） |

## 2. 实施范围（v2 修订后：chat + quizAttempt）

**新增：**
- `lib/runtime/shadow-writer.ts`（核心模块）：开关守卫、fetch 封装（8s AbortController；timeout/network/5xx 重试 ≤2 次，backoff 1s/4s；validation/auth/4xx/idempotency_conflict 不重试）、`runtime_shadow` 遥测上报、对外入口 `shadowChatSessions` / `shadowQuizSubmitted` / `shadowQuizReviewed` / `shadowQuizRetry`。（初版的 `shadowPlaybackProgress` 已随 playback 移出 R2 撤销。）
- `tests/runtime-shadow/`（2 个文件，30 个用例；初版的 playback-shadow.test.ts 已删除）。

**修改（挂点与支撑）：**
- `app/api/client-diagnostics/route.ts`：`runtime_shadow` 事件白名单分支（outcome/op/kind/durationBucket/shadowVersion），带 userId 落日志；kind 白名单按验收卡收缩为 `chat | quizAttempt`。
- `lib/quiz/persistence.ts`：**单键提交 envelope**——`writeSubmittedAnswers` 把 `{v, attemptId, answers}` 一次 setItem 原子写入 `quizAnswers:<sceneId>`；`readSubmittedEnvelope`/`readAttemptId` 供影子路径读回；`readSubmittedState`/`readAnswersForSummary` 兼容 envelope 与 legacy 裸 answers（读路径行为不变）；`clearSubmitted`/`clearAllForScene` 删 envelope 并做 legacy 双键残留清理。
- `lib/utils/chat-storage.ts`：`saveChatSessions` 非空路径尾部挂 `void shadowChatSessions(...)`；删除路径（空 sessions）影子期不动。
- `components/scene-renderers/quiz-view.tsx`：三个调用点挂影子写（submit 后、reviewed 后、retry 时——retry 必须先于 clearSubmitted 调用）；stageId 来自 `useStageStore`，为 null 时静默跳过。
- `.env.example`：开关注释文档（标注 playback 已移出 R2）。
- ~~`lib/utils/database.ts` / `lib/utils/playback-storage.ts` / `components/edit/PlaybackChromeRoot.tsx`~~：初版的 playback 字段与挂点**已按验收卡全部撤销**，与 main 基线一致。

## 3. Codex P0 的落实方式（v2 修订后）

**P0-1 playback `runtimeShadowEventId`**：**已移出 R2**（Codex 验收卡拍板）。初版实现只在单次函数调用内重试复用 eventId，没有从 Dexie 读回做刷新/跨标签页恢复，不满足硬门禁；补恢复实质是 pending/outbox，与 R2 边界冲突。playback 影子写另立 R2.1/R3 前置卡，设计稿 1.3 节留作素材。

**P0-2 quiz `attemptId`（envelope 修订版）**：attemptId 与 answers 在 `writeSubmittedAnswers` 内以**单键 envelope 同一次原子写入**——一次 setItem 要么整体成功要么整体失败，不存在孤立 attemptId（初版「双 setItem 天然原子」是错误声明，已改正）。safeSet 吞错不再影响正确性：影子路径只认 `readSubmittedEnvelope` 读回的持久化数据，写失败/legacy 裸 answers 读不到 envelope 即跳过，**不使用调用方内存数据**。draft 阶段不生成；`clearSubmitted` 删 envelope 后下一周期才生成新值。会话 id = `qa:<stageId>:<sceneId>:<attemptId>`。

## 4. 实施中发现并处置的两个设计前提偏差（v2：Codex 已拍板）

1. **quizAttempt phase 枚举**：设计稿用本地词表 `answering`/`reviewing`（那是 `SubmittedState.kind` 的词表），DSL `QuizAttemptPhase` 枚举实为 `'draft' | 'submitted' | 'reviewed'`（`packages/@openmaic/dsl/src/runtime.ts:332`）。实施采用 DSL 枚举值 `submitted`/`reviewed`。**Codex 验收卡：认可实施，仅修订设计文档（设计稿 v2.1 已勘误）。**
2. **playback 本地持久化已死**：设计稿（及 Codex P0 措辞）假设「每次保存进度时把 eventId 随快照持久化到 Dexie 的 playbackState 行」是既有行为。实际核查：`savePlaybackState` 在全仓**无任何调用方**——v0.3.1 rebase 后 PlaybackChromeRoot 从未给引擎接 `onProgress`，本地 playbackState 表当前不产生任何写入，`loadPlaybackState` 同样无调用方。初版处置（影子路径内恢复本地写入）**不被 Codex 认可**，playback 已整体移出 R2；该「死接线」事实留作 R2.1/R3 前置卡的输入。

## 5. 验收结果（v2 修订后重跑）

| 门禁 | 结果 |
|---|---|
| `vitest tests/runtime-shadow tests/quiz` | ✅ 69/69（runtime-shadow 30 用例 + quiz 套件回归） |
| `tsc --noEmit` | ✅ 0 error |
| 全量 `vitest run --no-file-parallelism` | ✅ 2076 passed；仅 8 个 `tests/edit/round-trip/` 存量导入解析失败（pptxgenjs/tinycolor2，非本次引入，与 R1.1 时基线一致） |

**P0 专项测试（含验收卡新增门禁）**：
- `attempt-id.test.ts`（10 例）：envelope 单键原子写（无独立 attemptId 键）/**注入写失败 → 无孤立 attemptId、无部分状态，故障解除后重新提交生成新周期**/刷新恢复复用同一 id/**跨标签页读同一 id、仅 draft 的标签页不产生 attemptId**/clearSubmitted 删 envelope 后新周期新 id/legacy 双键残留清理/legacy 裸 answers 读路径兼容 + 影子路径拿不到 attemptId/legacy 提交升级 envelope/跨 scene 隔离。
- `shadow-writer.test.ts`（20 例）：开关语义（unset/'0'/无 stageId 全静默）、**验收卡门禁——注入提交写失败零影子请求、无持久化 envelope 拒绝内存数据、legacy 裸 answers 不影子化**、quiz 全流程请求形状（envelope 读回）、刷新后同会话 id 重放、create 409 → ok_idempotent 继续 append、chat 折叠增量/截断游标重置/单条 folded PATCH/interrupted→active 映射、5xx/network/timeout 有界重试、validation/auth/idempotency_conflict 不重试、遥测分母形状。

## 6. 已知限制（影子期可接受，R3 前需评审）

1. **chat 会话状态只跟随到 completed**：archived 在 Dexie 词表不存在（idle/active/interrupted/error → active；completed → completed）。
2. **chat 截断重放**：游标越过当前长度时归零重放 ≤200 条，依赖 record id 稳定 + 服务端幂等（同 id 同内容返回已有行）。重放会产生一次性额外请求，不影响正确性。
3. **影子会话丢失不可自愈**：created 标记在 localStorage，若服务端会话被删而标记仍在，append 会 404 并计入 http_4xx；影子期数据可丢弃，未做自愈循环。
4. **并发覆写**：两次 saveChatSessions 并发时的影子写可能交错，同 id 同内容幂等兜底，最坏结果是重复的 ok_idempotent 计数。
5. **legacy 裸 answers 不影子化**：envelope 之前的存量提交没有 attemptId，影子路径读不到 envelope 即跳过（本就不在 R2 影子范围）；业务读路径完全兼容。
6. **字段裁剪仅限影子期**（Codex 拍板）：chat 不带 title/config/toolCalls，quiz 的 results 虽在 payload 但影子数据不得作为未来读源或审计依据；R3 另行评审完整消息语义。

## 7. 未做事项（明确不在 R2 范围）

- 任何 Supabase SQL / 迁移；Preview/生产开关设置（需先建隔离 Supabase Preview/Scratch，由负责人单独授权）。
- **playback 影子写**（另立 R2.1/R3 前置卡）。
- redeem merge-grant 签发端对接；匿名写；outbox/弱网重试队列；双读比对；读源切换。
- R2 不设 SLO——`runtime_shadow` 遥测上线后先观察成功率分布再定。

## 8. 建议下一步

1. Codex 重新验收（本报告 v2 + 设计稿 v2.1 + 验收卡修订 commit）。
2. 签字后 → 按 Codex 终审前置条件建隔离 Supabase Preview/Scratch 环境 → 执行迁移验证 → 方可在受控环境开 `NEXT_PUBLIC_RUNTIME_SHADOW=1` 观察影子数据。
3. playback 前置卡（R2.1/R3）与 R3（切读源）设计评审另行立项。
