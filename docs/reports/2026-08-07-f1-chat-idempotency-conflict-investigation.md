# F-1 调查报告：chat 影子写 IDEMPOTENCY_CONFLICT 409 循环

**日期**: 2026-08-07
**调查人**: Kimi（Codex 角色）
**性质**: 只读排查（未改任何代码）
**发现出处**: 2026-08-06 R3.1a Preview E2E（报告 `6f658d84` §3）

---

## 1. 现象（Preview 实证）

课堂播放期间，chat 会话 `session-1786018601050-xy5wdnq65ho` 产生：
- `POST /api/runtime/v1/sessions` 409 ×4（create CONFLICT，幂等成功路径，无害）
- `POST …/records` 409 ×6+，响应体：
  `IDEMPOTENCY_CONFLICT — record id "session-…:lecture-msg-1786018601050" was already used with different content`

## 2. 根因（代码证据链）

**R2 设计假设被 lecture 消息打破。**

1. `components/chat/use-chat-sessions.ts:1412-1433`（`startLecture`）：
   lecture 会话只建**一条**消息 `lecture-msg-<ts>`，初始 `parts: []`，后续每个 speech action 通过 StreamBuffer **向这同一条消息追加文本**——消息内容随播放持续增长。
2. `lib/runtime/shadow-writer.ts:366-387`（chat 影子写循环）：
   record id = `<sessionId>:<msg.id>`，payload.content = `messageText(msg.parts)` = **追加时刻的全量文本**。
3. `shadow-writer.ts:362-363` 的设计注释声称「内容（role/content/createdAt）确定，重放安全」——对普通问答消息成立（入列后不可变），**对 lecture 消息不成立**（可变、持续增长）。

**冲突产生路径**：
- 保存 #N：append lecture record，内容 T₁；请求客户端失败/超时，但服务端可能已落库；游标不前进（`r.ok=false → return`，行 380-384）
- 保存 #N+1：同一 record id 重试，内容已变为 T₂（新语音流入）→ 服务端 R1.1 严格幂等校验 → **409 IDEMPOTENCY_CONFLICT**
- 一旦冲突：游标永远越不过这条中毒记录 → **之后每次保存都重试这条**（内容还在变）→ 无限 409 循环。与观察到的 6+ 次完全吻合
- 次要路径：`cursor.count > messages.length` 归零重放（行 364）同样会把「长大了的」lecture 消息重放成 409

**为何 R2 验收没拦住**：R2 chat E2E 只测了「用户发一条普通消息」的不可变场景，lecture（单条持续增长消息）不在测试矩阵内。

## 3. 影响面

- 仅 chat 直写影子路径（R2）；playback（R3.1a outbox）/quiz（R3.2 outbox）不受影响
- 服务端数据：首个成功版本保留，后续增量文本丢失（影子数据不完整，本地 Dexie 不受影响）
- 无用户可见故障；代价是 409 噪音 + chat 影子数据残缺

## 4. 修复方向（供设计卡讨论，本报告不定案）

| 方案 | 做法 | 评价 |
|---|---|---|
| M1 止血（推荐先行） | chat 路径遇 IDEMPOTENCY_CONFLICT → 游标跳过中毒记录 + telemetry 计数，不再重试 | 改动小，消除无限 409；代价是该消息后续增量文本不进影子 |
| M2 正解（设计卡） | lecture 按 speech action 拆 record：id = `lecture-msg-<ts>:action-<n>`，每条不可变、确定性 | 符合幂等语义；改 chat 影子映射，建议与「chat 迁 outbox」合并设计 |
| M3 | lecture 消息只在会话 completed 后影子一次 | 最简单但失去增量影子 |

**建议**：M1 立即做（小修复卡），M2 纳入 chat-outbox 迁移设计卡（与排队项③旧 outbox 终结方案一并评审）。

## 5. 建议门禁（M1）

- 单测：lecture 消息首轮 append 内容 T₁ 成功、游标模拟未前进、次轮内容 T₂ → 收到 IDEMPOTENCY_CONFLICT → 断言游标跳过该条、后续消息继续 append、仅一次 telemetry
- 回归：既有 chat/quiz/playback shadow 测试全绿

---

**状态**: ✅ 调查完成，根因确认 — 待负责人拍板 M1 止血卡
