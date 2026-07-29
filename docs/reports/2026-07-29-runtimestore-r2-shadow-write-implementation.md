# R2 影子双写实施报告 — RuntimeStore shadow write

- 日期：2026-07-29
- 实施：Kimi K3
- Commit：`5e6c1366` feat(runtime): R2 shadow write — chat/quizAttempt/playback mirror to RuntimeStore (flag-gated, off by default)（已推送 origin `test/documentstore-parity`）
- 前置：R2 设计稿 v2（`692cf9b7`，Codex 终审 4 项拍板 + 2 个 P0 已落实）；R1.1 服务端基础设施（`52862d2e` 签字收官）

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
| runtimeShadowEventId 与 quiz attemptId 与原数据同一次本地写入持久化 | ✅ 见 §3 |
| 测试覆盖刷新后重试仍复用同一 ID | ✅ 见 §5 |

## 2. 实施范围

**新增：**
- `lib/runtime/shadow-writer.ts`（核心模块，~470 行）：开关守卫、fetch 封装（8s AbortController；timeout/network/5xx 重试 ≤2 次，backoff 1s/4s；validation/auth/4xx/idempotency_conflict 不重试）、`runtime_shadow` 遥测上报、三个对外入口 `shadowChatSessions` / `shadowQuizSubmitted` / `shadowQuizReviewed` / `shadowQuizRetry` / `shadowPlaybackProgress`。
- `tests/runtime-shadow/`（3 个文件，30 个用例）。

**修改（挂点与支撑，共 8 个文件、+95 行）：**
- `app/api/client-diagnostics/route.ts`：`runtime_shadow` 事件白名单分支（outcome/op/kind/durationBucket/shadowVersion），带 userId 落日志。
- `lib/quiz/persistence.ts`：`ATTEMPT_ID_PREFIX = 'quizAttemptId:'` + `readAttemptId`；`writeSubmittedAnswers` 内同一次写入生成 attemptId；`clearSubmitted`/`clearAllForScene` 一并清除。
- `lib/utils/database.ts`：`PlaybackStateRecord` 加 `runtimeShadowEventId?: string`（IndexedDB 无模式约束，无需升版本）。
- `lib/utils/playback-storage.ts`：`PlaybackSnapshot` 加同名字段并透传进 put。
- `lib/utils/chat-storage.ts`：`saveChatSessions` 非空路径尾部挂 `void shadowChatSessions(...)`；删除路径（空 sessions）影子期不动。
- `components/scene-renderers/quiz-view.tsx`：三个调用点挂影子写（submit 后、reviewed 后、retry 时——retry 必须先于 clearSubmitted 调用）；stageId 来自 `useStageStore`，为 null 时静默跳过。
- `components/edit/PlaybackChromeRoot.tsx`：PlaybackEngine 接 `onProgress → void shadowPlaybackProgress(stage?.id ?? null, snapshot)`。
- `.env.example`：开关注释文档。

## 3. Codex 两个 P0 的落实方式

**P0-1 playback `runtimeShadowEventId`**：每次进度快照先生成 UUID，随快照**同一次 Dexie put** 持久化（`savePlaybackState(stageId, {...snapshot, runtimeShadowEventId})`）；record id = `pb:<stageId>:<eventId>`；本地写失败则放弃本次影子写（不产生无锚点的服务端孤儿记录）；重试复用同一 id（有测试：5xx 后重试两次 append 的 record id 完全相同）。

**P0-2 quiz `attemptId`**：在 `writeSubmittedAnswers` 内与 answers **同一次 localStorage 写入**（同步 API 天然原子）；draft 阶段不生成；`clearSubmitted` 清除后下一次提交才生成新值。会话 id = `qa:<stageId>:<sceneId>:<attemptId>`，刷新后继续/重试均定位同一会话（有测试）。

## 4. 实施中发现并处置的两个设计前提偏差

1. **quizAttempt phase 枚举**：设计稿用本地词表 `answering`/`reviewing`（那是 `SubmittedState.kind` 的词表），DSL `QuizAttemptPhase` 枚举实为 `'draft' | 'submitted' | 'reviewed'`（`packages/@openmaic/dsl/src/runtime.ts:332`）。实施采用 DSL 枚举值 `submitted`/`reviewed`，否则服务端 payload 校验会 400。**建议设计稿 v2 对应行作相应勘误。**
2. **playback 本地持久化已死**：设计稿（及 Codex P0 措辞）假设「每次保存进度时把 eventId 随快照持久化到 Dexie 的 playbackState 行」是既有行为。实际核查：`savePlaybackState` 在全仓**无任何调用方**——v0.3.1 rebase 后 PlaybackChromeRoot 从未给引擎接 `onProgress`，本地 playbackState 表当前不产生任何写入，`loadPlaybackState` 同样无调用方。处置：`shadowPlaybackProgress` 内部完成「生成 eventId → savePlaybackState 同一次 put → 影子 append」全链路，且仅在开关开启时执行。**开关关闭 = 本地行为与现状逐字节一致**；开关开启 = 恢复本地 playbackState 写入（无读取方，不影响任何读取行为）+ 影子写。此偏差建议同步给 Codex 备案。

## 5. 验收结果

| 门禁 | 结果 |
|---|---|
| `vitest tests/runtime-shadow tests/quiz` | ✅ 68/68（新增 30 用例） |
| `tsc --noEmit` | ✅ 0 error |
| 全量 `vitest run --no-file-parallelism` | ✅ 2076 passed；仅 8 个 `tests/edit/round-trip/` 存量导入解析失败（pptxgenjs/tinycolor2，非本次引入，与 R1.1 时基线一致） |

**P0 专项测试**：
- `attempt-id.test.ts`：attemptId 与 answers 同一次写入 / 模拟刷新后复用 / draft 不生成 / clearSubmitted 后新周期新 id / 跨 scene 隔离（6 例）。
- `playback-shadow.test.ts`：开关关闭零本地写零 fetch / eventId 随快照同一次 savePlaybackState 调用 / record id 用持久化 eventId / 5xx 重试复用同 id / 每次保存生成新 id / 本地写失败放弃影子写（6 例）。
- `shadow-writer.test.ts`：开关语义（unset/'0'/无 stageId 全静默）、quiz 全流程请求形状、刷新后同会话 id 重放、create 409 → ok_idempotent 继续 append、chat 折叠增量/截断游标重置/单条 folded PATCH/interrupted→active 映射、5xx/network/timeout 有界重试、validation/auth/idempotency_conflict 不重试、遥测分母形状（17 例）。

## 6. 已知限制（影子期可接受，R3 前需评审）

1. **chat 会话状态只跟随到 completed**：archived 在 Dexie 词表不存在（idle/active/interrupted/error → active；completed → completed）。
2. **chat 截断重放**：游标越过当前长度时归零重放 ≤200 条，依赖 record id 稳定 + 服务端幂等（同 id 同内容返回已有行）。重放会产生一次性额外请求，不影响正确性。
3. **影子会话丢失不可自愈**：created 标记在 localStorage，若服务端会话被删而标记仍在，append 会 404 并计入 http_4xx；chat 路径会在 append 404 时保留游标待下次保存重建（create 折叠标记未自动清除——影子期数据可丢弃，未做自愈循环）。
4. **并发覆写**：两次 saveChatSessions 并发时的影子写可能交错，同 id 同内容幂等兜底，最坏结果是重复的 ok_idempotent 计数。
5. **playback 记录量**：引擎每个 action 前进一次都产生一条 record（一门课可能数百条）。影子期可接受；R3 切读前需评估聚合/采样策略。
6. **字段裁剪仅限影子期**（Codex 拍板）：chat 不带 title/config/toolCalls，quiz 的 results 虽在 payload 但影子数据不得作为未来读源或审计依据；R3 另行评审完整消息语义。

## 7. 未做事项（明确不在 R2 范围）

- 任何 Supabase SQL / 迁移；Preview/生产开关设置（需先建隔离 Supabase Preview/Scratch，由负责人单独授权）。
- redeem merge-grant 签发端对接；匿名写；outbox/弱网重试队列；双读比对；读源切换。
- R2 不设 SLO——`runtime_shadow` 遥测上线后先观察成功率分布再定。

## 8. 建议下一步

1. Codex 验收本报告（重点：§4 两个设计前提偏差的处置是否认可）。
2. 验收通过 → 按 Codex 终审前置条件建隔离 Supabase Preview/Scratch 环境 → 执行迁移验证 → 方可在受控环境开 `NEXT_PUBLIC_RUNTIME_SHADOW=1` 观察影子数据。
3. R3（切读源）设计评审另行立项。
