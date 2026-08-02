# Runtime chat `idempotency_conflict` 调查报告（只读）

- 日期：2026-08-02
- 调查人：架构师（rj-laixue-architect）
- 施工目录：`D:\WorkBuddy 地界\RJ-laixue-storage-b2`
- 分支：`test/documentstore-parity`
- 调查边界：只读 Preview 日志/记录与本地代码；未读取生产业务数据；未修改任何代码

---

## 1. 摘要与结论

### 一句话根因

**`shadowChatSessions` 缺少并发互斥控制（mutex），两次防抖保存可以在第一条影子写仍在途时启动第二条，两者读取同一个游标、发送同一个 record ID，但消息内容因流式增量揭示而已发生变化，服务端逐字段比对不通过，返回 409 `IDEMPOTENCY_CONFLICT`。**

### 核心结论

| 问题 | 结论 |
|---|---|
| record ID 生成层 | shadow-writer 客户端层，`<sessionId>:<msg.id>`，稳定绑定原始消息 |
| 漂移字段 | **`payload.content`**（流式文本从 partial 增长到 final）；`role`/`createdAt`/`sceneId` 均稳定 |
| 触发链路 | 防抖保存(500ms) → `shadowChatSessions`(async, 网络I/O) 未完成时第二次防抖保存再触发 → 并发读同一游标 → 同 ID 不同 content |
| 是否可复现 | 可在单测中通过延迟 fetch 响应 + 两次 `shadowChatSessions` 并发调用稳定复现 |
| 最小处置 | **per-session mutex 串行化 `shadowChatSessions`**；替代方案见 §6 |
| 对 R3 的影响 | **仅 chat 阻断**，通用幂等/outbox 设计不需调整；playback 的 Dexie pending 模型是正确参照 |

### 不推翻 R2/R2.1 签字

- R2 的"409 不重试但遥测"行为完全正确——服务端幂等冲突检测按设计工作。
- quizAttempt 和 playback 影子写不受此问题影响（前者从持久化 envelope 读回，后者用 Dexie 事务串行化）。
- 问题仅在 chat 影子写路径，根因是客户端并发控制缺失，不是服务端幂等设计缺陷。

---

## 2. record ID 生成链路分析

### 2.1 生成位置

**文件**：`lib/runtime/shadow-writer.ts`，`shadowOneChatSession` 函数，第 371 行：

```typescript
id: `${session.id}:${msg.id}`,
```

record ID 由两部分拼接：

| 组成 | 来源 | 生成位置 | 稳定性 |
|---|---|---|---|
| `session.id` | ChatSession.id | `use-chat-sessions.ts` 第 696/1255/1412 行：`session-${Date.now()}-${Math.random()...}` | 会话生命周期内稳定 |
| `msg.id` | UIMessage.id | 用户消息：`user-${Date.now()}`（第 1084 行）；助手消息：SSE `agent_start` 事件的 `messageId`（第 278 行）；讲义消息：`lecture-msg-${Date.now()}`（第 1414 行） | 消息生命周期内稳定 |

### 2.2 稳定性判定

record ID **稳定绑定原始消息**。`session.id` 和 `msg.id` 在各自对象创建后均不被修改。刷新后从 IndexedDB 重新加载，两个 ID 均从持久化数据恢复，保持不变。

**结论：record ID 不是漂移源。**

### 2.3 与 playback/quizAttempt 的对比

| kind | record ID 生成 | 幂等锚点来源 |
|---|---|---|
| chat | `<sessionId>:<msg.id>`（客户端拼接） | 内存中的 UIMessage（**流式可变**） |
| quizAttempt | `<sessionId>:submit` / `<sessionId>:grade`（客户端拼接） | localStorage envelope（持久化，**不可变**） |
| playback | `pb:<stageId>:<eventId>`（客户端拼接） | Dexie 行的 `runtimeShadowEventId`（持久化，**事务内生成后冻结**） |

chat 是唯一从**可变内存状态**读取幂等锚点内容的 kind。

---

## 3. 内容漂移字段定位

### 3.1 record 字段逐一分析

shadow-writer 第 368-378 行构造的 record body：

```typescript
{
  id: `${session.id}:${msg.id}`,                                           // (A)
  createdAt: new Date(msg.metadata?.createdAt ?? session.createdAt).toISOString(), // (B)
  payload: { role: msg.role, content: messageText(msg.parts) },            // (C)
  ...(session.sceneId ? { sceneId: session.sceneId } : {}),                // (D)
}
```

服务端比对逻辑（`lib/server/runtime-store/pg.ts` 第 381-387 行）：

```typescript
const echoMatches =
  stored.session_id === init.sessionId &&
  toIso(stored.created_at) === init.createdAt &&
  (stored.scene_id ?? undefined) === init.sceneId &&
  (stored.action_index ?? undefined) === init.actionIndex &&
  (stored.sub_anchor ?? undefined) === init.subAnchor &&
  deepEqual(stored.payload, init.payload === undefined ? null : init.payload);
```

| 字段 | 代码 | 漂移？ | 分析 |
|---|---|---|---|
| **(A) id** | `${session.id}:${msg.id}` | ❌ 稳定 | 见 §2 |
| **(B) createdAt** | `msg.metadata?.createdAt ?? session.createdAt` | ❌ 稳定 | `metadata.createdAt` 在消息创建时设为 `Date.now()`（`onAgentStart` 第 286 行、`sendMessage` 第 1099 行），此后不被修改。fallback `session.createdAt` 同样在会话创建时设定且不变。shadow-writer 第 373 行注释明确说明了这一点。 |
| **(C) payload.content** | `messageText(msg.parts)` | ✅ **漂移** | 流式揭示过程中 `msg.parts` 的 text 段文本持续增长（见 §3.2） |
| **(C) payload.role** | `msg.role` | ❌ 稳定 | 消息创建时设为 `'user'` 或 `'assistant'`，此后不变 |
| **(D) sceneId** | `session.sceneId` | ❌ 稳定 | QA/Discussion 会话不设 sceneId（undefined）；lecture 会话在 `startLecture` 时设定且不变 |

### 3.2 content 漂移机制

`messageText` 函数（第 327-339 行）从 `msg.parts` 中提取所有 `type === 'text'` 段的 `text` 并拼接：

```typescript
function messageText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p): p is { type: 'text'; text: string } => /* ... */)
    .map((p) => p.text)
    .join('');
}
```

流式消息的生命周期（`use-chat-sessions.ts`）：

| 阶段 | 触发 | parts 状态 | `messageText` 返回 |
|---|---|---|---|
| 消息创建 | `onAgentStart`（第 274-296 行） | `parts: []` | `""`（空字符串） |
| 文本增量揭示 | `onTextReveal`（第 312-349 行） | `parts: [{ type: 'text', text: "部分文本" }]` | `"部分文本"` |
| 继续揭示 | `onTextReveal` 再次调用 | `parts: [{ type: 'text', text: "更长的文本" }]` | `"更长的文本"` |
| 流式结束 | 最后一次 `onTextReveal` | `parts: [{ type: 'text', text: "完整文本" }]` | `"完整文本"` |
| 中断/结束 | `endSession`/`softPauseSession`/`sendMessage` 中断（第 755-792、855-893、1012-1045 行） | text 段末尾追加 `"..."` | `"完整文本..."` |

**`onTextReveal` 原地更新 parts 中的 text 段**（第 330-341 行：找到已存在的 `_partId` 匹配项并替换 `text`），消息 ID 不变，但 `content` 持续增长。

### 3.3 结论

**漂移字段是 `payload.content`**，由流式消息从 partial 到 final 的增量揭示导致。`role`、`createdAt`、`sceneId` 均不漂移。

---

## 4. 触发链路与根因

### 4.1 完整触发链路

```
用户发送消息 / Agent 开始回复
  ↓
onAgentStart → setSessions（创建 parts:[] 的助手消息）
  ↓
useEffect → setChats(sessions) → debouncedSave()（500ms 防抖）
  ↓
[500ms 内无新 tick]
  ↓
saveToStorage() → saveStageData() → saveChatSessions()
  ↓
void shadowChatSessions(stageId, sessions)    ← 【调用 A】异步，不 await
  ↓
shadowOneChatSession:
  cursor = readChatCursor(session.id)         ← cursor.count = N
  循环发送 messages[N..]
  appendRecord → fetch(POST /records)         ← 网络请求在途...
  cursor.count = N+1                           ← 尚未执行（等 fetch 返回）
  ↓
[同时，流式继续]
onTextReveal → setSessions（更新 parts 文本）
  ↓
useEffect → setChats(sessions) → debouncedSave()（500ms 防抖）
  ↓
[500ms 内无新 tick，而调用 A 的 fetch 仍在途]
  ↓
saveToStorage() → saveStageData() → saveChatSessions()
  ↓
void shadowChatSessions(stageId, sessions)    ← 【调用 B】与 A 并发！
  ↓
shadowOneChatSession:
  cursor = readChatCursor(session.id)         ← 仍是 cursor.count = N（A 还没来得及更新）
  循环发送 messages[N..]
  appendRecord → fetch(POST /records)         ← 同一 record ID，content 已不同！
```

### 4.2 服务端冲突过程

```
调用 A 的 fetch 到达服务端：
  runtime_append_record → 'ok'（新插入）
  存储 record: { id: "cs1:msg1", payload: { content: "部分文本" } }

调用 B 的 fetch 到达服务端：
  runtime_append_record → 'id_conflict'（同 ID 已存在）
  runtime_get_record 取回已存行
  echoMatches 比对：
    stored.payload.content = "部分文本"
    init.payload.content   = "更长的文本"     ← 不匹配！
  → throw IDEMPOTENCY_CONFLICT
  → HTTP 409
```

### 4.3 根因：缺少并发互斥

`shadowChatSessions` 是 `async` 函数，通过 `void shadowChatSessions(...)` 以 fire-and-forget 方式调用（`chat-storage.ts` 第 56 行）。没有任何机制阻止两个调用并发执行：

- **无 mutex/lock**：没有 per-session 的串行化锁
- **无 in-flight 标记**：不检查上一次调用是否完成
- **游标非原子**：`readChatCursor` → 发送 → `writeChatCursor` 不是原子操作，中间存在 TOCTOU 窗口

### 4.4 排除的其他原因

| 假设 | 排除理由 |
|---|---|
| 流式 partial → final（本身） | 部分正确——partial→final 是 content 漂移的**机制**，但不是冲突的**直接原因**。如果没有并发，游标会在第一次成功写入后前进，第二次保存不会重发同一消息。**并发才是直接原因。** |
| 消息对象原地更新 | 同上——原地更新是漂移机制，不是冲突原因。 |
| 截断游标归零 | 需要 >200 条消息触发截断。Preview E2E 不可能达到此量级。代码路径存在（第 364 行），但不是本次冲突的原因。 |
| 刷新重放 | 刷新后从 IndexedDB 加载（内容为最终态），游标从 localStorage 恢复。如果游标丢失则全量重发，但内容一致（从 IndexedDB 读回），不会冲突。 |
| 跨标签页 | Preview E2E 是单标签页操作。理论上跨标签页共享 localStorage 游标可加剧问题，但不是本次触发原因。 |
| createdAt fallback 漂移 | `metadata.createdAt` 在消息创建时设定且不变。fallback `session.createdAt` 同样稳定。不漂移。 |

### 4.5 加剧因素

以下设计决策加大了并发窗口：

1. **防抖间隔 500ms** vs **网络 I/O 数秒**：`debouncedSave` 的 500ms 间隔远短于一次影子写的网络耗时（含 8s 超时 + 重试），使得并发窗口几乎必然出现。
2. **`onTextReveal` 不更新 `updatedAt`**（第 345 行注释："Don't update updatedAt on every tick"）：这减少了 `setChats` 的频率，但如果 `onAgentStart` 和 `onTextReveal` 之间有 >500ms 间隔（网络延迟、模型首 token 延迟），防抖就会在空 parts 时触发。
3. **`onActionReady` 更新 `updatedAt`**（第 370 行）：action 到达时更新 `updatedAt` 并触发 `setChats` → `debouncedSave`，可能在第一次影子写仍在途时触发第二次保存。

---

## 5. 复现条件与影响范围

### 5.1 复现条件

必要条件（全部满足）：

1. `NEXT_PUBLIC_RUNTIME_SHADOW=1`（影子写开启）
2. Chat 会话处于流式回复中（消息 parts 正在增长）
3. 防抖保存在消息内容为 partial 时触发第一次 `shadowChatSessions`
4. 第一次 `shadowChatSessions` 的网络请求尚未返回（游标未前进）
5. 消息内容在此期间发生变化（文本继续揭示）
6. 防抖保存在内容变化后触发第二次 `shadowChatSessions`

### 5.2 单测复现方案

可在 `tests/runtime-shadow/shadow-writer.test.ts` 中添加以下测试：

```typescript
it('concurrent shadowChatSessions with content drift → idempotency_conflict', async () => {
  process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
  
  // 第一次调用：消息内容为 partial
  const partialSession = makeChatSession('cs1', ['m1']);
  (partialSession.messages[0].parts as any[])[0].text = 'partial';
  
  // 延迟 fetch 响应，模拟网络 I/O
  let resolveFirst: (v: Response) => void;
  const firstFetch = new Promise<Response>((r) => { resolveFirst = r; });
  fetchMock.mockImplementationOnce(async () => firstFetch);
  
  const p1 = shadowChatSessions('stage1', [partialSession]); // 不 await
  
  // 内容增长到 final
  const finalSession = makeChatSession('cs1', ['m1']);
  (finalSession.messages[0].parts as any[])[0].text = 'partial + more text';
  
  // 第二次调用（游标未前进，同一 record ID）
  const p2 = shadowChatSessions('stage1', [finalSession]);
  
  // 解析第一次 fetch → 201
  resolveFirst!(jsonResponse(201));
  await p1;
  
  // 第二次 fetch → 409（服务端检测到同 ID 不同内容）
  // ...验证 telemetry 包含 idempotency_conflict
});
```

### 5.3 发生频率

- **Preview E2E 观察**：1 条冲突，出现在 R2.1 playback E2E 同期。具体 chat records 总量未知（报告未统计分母），但冲突率为低个位数百分比量级。
- **预期频率**：在流式聊天 + 影子写开启的环境下，每次 QA/Discussion 会话都有概率触发。频率取决于：
  - 模型首 token 延迟（延迟越大，空 parts 窗口越长，第一次写入空内容的概率越高）
  - 网络延迟（延迟越大，并发窗口越长）
  - 防抖间隔与文本揭示频率的比值

### 5.4 影响范围

| 范围 | 影响 |
|---|---|
| chat 影子写 | **受影响**——content 漂移导致 409，游标不前进，该消息的影子写永久卡住（每次保存都重试并冲突） |
| quizAttempt 影子写 | **不受影响**——从 localStorage envelope 读回，内容不可变 |
| playback 影子写 | **不受影响**——从 Dexie 行读回，eventId 事务内生成后冻结，且有 pending 机制串行化 |
| 本地 chat 存储 | **不受影响**——影子写是 fire-and-forget，409 不影响 Dexie 保存 |
| 用户体验 | **不受影响**——影子写失败不抛出、不阻塞 |

### 5.5 游标卡住后果

一旦某条消息的影子写因 409 失败，游标不前进（第 380-383 行）。后续每次 `saveChatSessions` 都会重试该消息：

- 如果消息内容已稳定（流式结束），重试发送的 content 与服务端存储的 partial content 仍不同 → 持续 409
- 该消息之后的所有新消息都无法被影子化（游标卡在前面）
- **这意味着一条 409 会导致该会话后续所有 chat records 都无法写入服务端**

---

## 6. 处置建议

### 6.1 推荐方案：per-session mutex 串行化（最小改动）

**原理**：在 `shadowChatSessions` 入口添加 per-session 互斥锁，确保同一会话的影子写串行执行。

**改动范围**：仅 `lib/runtime/shadow-writer.ts`

**伪方案**：

```typescript
// 在 shadow-writer.ts 中添加 per-session mutex
const sessionLocks = new Map<string, Promise<void>>();

async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T | undefined> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  let release: () => void;
  const current = new Promise<void>((r) => { release = r; });
  sessionLocks.set(sessionId, prev.then(() => current));
  await prev;
  try {
    return await fn();
  } finally {
    release!();
    if (sessionLocks.get(sessionId) === current) {
      sessionLocks.delete(sessionId);
    }
  }
}
```

在 `shadowOneChatSession` 调用处包裹：

```typescript
export async function shadowChatSessions(stageId: string, sessions: ChatSession[]): Promise<void> {
  if (!isRuntimeShadowEnabled() || !sessions || sessions.length === 0) return;
  for (const session of sessions) {
    await withSessionLock(session.id, async () => {
      try {
        await shadowOneChatSession(stageId, session);
      } catch { /* fire-and-forget */ }
    });
  }
}
```

**注意**：`shadowChatSessions` 内部从 `for...of` + `await` 改为串行等待。但调用方仍以 `void` 调用，不阻塞业务。第二次调用会在 mutex 队列中等待第一次完成后才执行。此时游标已前进，第二次调用只会发送增量消息，不会重发。

**优点**：
- 改动最小（仅 shadow-writer.ts）
- 不改变 record ID 方案
- 不改变服务端契约
- 不改变 payload 结构
- 直接消除并发根因

**缺点**：
- 不解决"partial 内容被写入服务端"的问题——第一次写入可能仍是 partial 内容。但由于游标会前进，后续不会冲突。R3 切读时需注意 chat shadow records 可能包含 partial 内容。
- 如果第一次写入超时（8s + 重试 29s），第二次调用会等待较长时间。可以通过 `withSessionLock` 超时跳过来缓解。

### 6.2 替代方案对比

| 方案 | 改动量 | 优点 | 缺点 | 推荐？ |
|---|---|---|---|---|
| **A. per-session mutex** | 小（仅 shadow-writer.ts） | 直接消除并发根因，不改变契约 | 不解决 partial 内容写入；极端情况下第二次调用等待久 | ✅ **推荐** |
| B. 延迟到消息稳定后写 | 中（需判断流式完成） | 保证写入的是 final 内容 | 难以可靠判断"稳定"——`onAgentEnd`/中断/错误都可能改变内容；需要新的稳定信号 | ❌ 复杂度高 |
| C. record ID 纳入 revision | 大（改 record ID 方案 + 服务端） | 同一消息的不同版本映射到不同 record | 破坏幂等语义（同消息 → 同 record 的核心假设）；需服务端支持 update/append 新版本 | ❌ 过度设计 |
| D. 冻结首写内容 | 中（需存储首写快照） | 保证重试时内容一致 | 需要额外的持久化（localStorage/Dexie）存储首写快照；增加复杂度 | ⚠️ 可作为方案 A 的补充 |
| E. chat 也用 Dexie pending 模型 | 大（仿照 playback A2） | 从持久化读回，事务串行化，根治问题 | 改动量大，接近 R2.1 playback 的工程量；R2 边界明确排除了 outbox | ⚠️ 留给 R3 |
| F. 防抖间隔加大到 >8s | 极小 | 减少并发概率 | 治标不治本；降低影子写及时性；不防直接 `saveStageData` 调用 | ❌ |

### 6.3 推荐实施路径

1. **立即（R2 观察期）**：实施方案 A（per-session mutex），消除并发根因。不需要改服务端、不需要改 record ID 方案、不需要改 payload 结构。
2. **R3 设计时**：评估方案 E（chat 也用 Dexie pending/outbox 模型），作为 R3 通用 outbox 设计的一部分。此时 chat shadow records 的内容完整性可得到保障。
3. **R3 切读前**：重新评审 chat payload 字段是否足够作为正式读源（R2 裁剪为 `{role, content}`，R3 需评审是否需要 `createdAt`、`agentId` 等）。

---

## 7. 对 R3 设计的影响结论

### 7.1 核心结论：仅 chat 阻断，通用幂等/outbox 不需调整

| 维度 | 结论 | 理由 |
|---|---|---|
| 服务端幂等设计 | ✅ 不需调整 | record ID 全局唯一 + 同 ID 同内容重放返回已有行 + 同 ID 不同内容 409，这是正确的幂等契约。问题在客户端并发，不在服务端。 |
| 通用 outbox 设计 | ✅ 不需调整 | playback 的 Dexie pending 模型（R2.1 A2）已证明可行：事务内生成 eventId + 冻结内容 + 条件清除。R3 通用 outbox 应以此 为模板。 |
| chat 切读 | ❌ 阻断 | 在修复并发问题前，chat shadow records 可能包含 partial 内容（空字符串或部分文本），不能作为正式读源。 |
| quizAttempt 切读 | ✅ 不阻断 | 从持久化 envelope 读回，内容不可变，无漂移风险。 |
| playback 切读 | ✅ 不阻断 | 从 Dexie 读回，eventId 冻结，事务串行化，无漂移风险。 |

### 7.2 R3 设计稿需补充的章节

基于本次调查，R3 总设计稿应在以下章节纳入 chat 特有的考量：

1. **按 kind 切读门禁**：
   - chat 切读前必须完成 per-session mutex 修复（或迁移到 Dexie pending 模型）
   - chat shadow records 的内容完整性门禁：需验证 record 内容为 final 而非 partial
   - 建议增加"内容稳定信号"（如 `onAgentEnd` 后的 `updatedAt` 变化）作为影子写触发条件之一

2. **通用 outbox**：
   - playback 单行 pending 是正确参照，不是默认答案——但它的"事务内生成 ID + 冻结内容 + 条件清除"模式应作为通用模板
   - chat 迁移到 outbox 模型时，每次消息内容变化应生成新 eventId（而非复用同一 record ID）
   - outbox 需支持"内容更新"语义（新 record 替代旧 record），而非仅"追加"语义

3. **顺序与冲突**：
   - 409 `IDEMPOTENCY_CONFLICT` 的处置策略：R2 的"不重试但遥测"在 shadow 阶段正确，但切读后需要区分"正常幂等重放"和"内容漂移冲突"
   - 建议在 409 响应中返回已存储内容的摘要（如 content hash），供客户端判断是否需要更新

4. **灰度控制面**：
   - chat 的 match 率统计需排除"partial 内容写入"导致的 false mismatch
   - 建议增加"内容稳定后重写"指标，衡量 partial→final 的漂移频率

### 7.3 对 R3 阶段状态机的影响

R3 阶段状态机 `local-only → shadow → dual-read compare → server-preferred → server-primary` 中：

- **chat 在 shadow → dual-read compare 阶段会因 partial 内容导致 mismatch**，需要额外的"内容稳定确认"步骤
- 建议为 chat 增加一个中间态：`shadow-unstable → shadow-stable`，其中 `shadow-stable` 要求消息流式结束后重写一次（或确认内容已稳定）
- quizAttempt 和 playback 不需要此中间态

---

## 8. 调查证据

### 8.1 代码路径与行号

| 证据 | 文件 | 行号 | 说明 |
|---|---|---|---|
| record ID 生成 | `lib/runtime/shadow-writer.ts` | 371 | `id: \`${session.id}:${msg.id}\`` |
| content 从 parts 提取 | `lib/runtime/shadow-writer.ts` | 327-339 | `messageText` 函数 |
| createdAt fallback | `lib/runtime/shadow-writer.ts` | 374 | `msg.metadata?.createdAt ?? session.createdAt` |
| 游标读写 | `lib/runtime/shadow-writer.ts` | 141-154 | `readChatCursor` / `writeChatCursor` |
| 游标不前进 on failure | `lib/runtime/shadow-writer.ts` | 380-383 | `if (!r.ok) { writeChatCursor(...); return; }` |
| 无并发控制 | `lib/runtime/shadow-writer.ts` | 409-418 | `shadowChatSessions` 直接循环 `await shadowOneChatSession`，无 mutex |
| fire-and-forget 调用 | `lib/utils/chat-storage.ts` | 56 | `void shadowChatSessions(stageId, sessions);` |
| 防抖间隔 500ms | `lib/store/stage.ts` | 560-562 | `debouncedSave = debounce(..., 500)` |
| setChats 触发防抖 | `lib/store/stage.ts` | 291-294 | `setChats: (chats) => { set({ chats }); debouncedSave(); }` |
| useEffect 同步 sessions | `components/chat/use-chat-sessions.ts` | 168-172 | `useEffect(() => { ... setChats(sessions); }, [sessions])` |
| onAgentStart 创建空 parts 消息 | `components/chat/use-chat-sessions.ts` | 277-288 | `parts: []` |
| onTextReveal 原地更新 parts | `components/chat/use-chat-sessions.ts` | 312-349 | 替换或新增 text part |
| endSession 追加 "..." | `components/chat/use-chat-sessions.ts` | 755-792 | `text: (textPart.text \|\| '') + '...'` |
| 服务端 IDEMPOTENCY_CONFLICT | `lib/server/runtime-store/pg.ts` | 381-393 | `echoMatches` 逐字段比对 |
| HTTP 409 映射 | `lib/server/runtime-store/http-error.ts` | 23 | `[/IDEMPOTENCY_CONFLICT/, { code: 'IDEMPOTENCY_CONFLICT', status: 409 }]` |
| 409 不重试但遥测 | `lib/runtime/shadow-writer.ts` | 203-214 | `outcome = 'idempotency_conflict'` → 返回 `{ ok: false }` |

### 8.2 日志证据

R2.1 Preview E2E 报告（`docs/reports/2026-08-02-runtimestore-r2.1-playback-preview-e2e.md` 第 39-42 行）：

```text
chat 影子出现 1 条 `runtime_shadow {outcome:"idempotency_conflict", op:"append_record", kind:"chat"}`
（record id 相同但内容不同，409 响亮计数不重试——R2 已签字语义）。对应网络层确有
chat records 409。
```

### 8.3 测试证据

现有测试 `tests/runtime-shadow/shadow-writer.test.ts` 第 393-404 行测试了 409 场景：

```typescript
it('append 409 counts as idempotency_conflict and is not retried', async () => {
  // ...
  responder = (url) => ({ status: url.includes('/records') ? 409 : 201 });
  await shadowChatSessions('stage1', [makeChatSession('cs1', ['m1'])]);
  expect(telemetryOutcomes()).toEqual(['ok', 'idempotency_conflict']);
  // 冲突后游标不前进，下次保存从同一下标重试
  // ...
});
```

该测试使用稳定内容（`text of m1`），未覆盖内容漂移场景。`makeChatSession`（第 80-99 行）创建的消息 parts 固定为 `[{ type: 'text', text: 'text of m1' }]`，不模拟流式增长。

### 8.4 playback 对比证据

playback shadow writer（`shadow-writer.ts` 第 540-653 行 `shadowPlaybackProgress`）：
- 从 Dexie 读回（第 546 行：`await db.playbackState.get(stageId)`），不从内存读
- eventId 在 Dexie rw 事务内生成并冻结（第 590-597 行）
- 条件清除在 Dexie rw 事务内按 eventId 执行（第 649 行：`clearPlaybackPending(stageId, eventId)`）
- 有完整的幂等状态机（A/B/C/D 四态分类，第 549-602 行）

chat shadow writer 没有上述任何机制，是三个 kind 中唯一从可变内存状态读取的。

---

## 附录 A：6 个问题直接回答

### Q1: record ID 从哪一层生成，是否稳定绑定原始消息？

**客户端 shadow-writer 层生成**，格式 `<sessionId>:<msg.id>`。`session.id` 和 `msg.id` 均在各自对象创建时设定且此后不变。**稳定绑定原始消息。** record ID 不是漂移源。

### Q2: 两次请求的 `role`、`content`、`createdAt`、`sceneId` 哪个字段不同？

**`content` 不同。** 流式消息的 `parts` 文本段在 partial 和 final 之间持续增长，`messageText(msg.parts)` 返回不同字符串。`role`、`createdAt`、`sceneId` 均稳定不变。

### Q3: 是否由以下原因导致？

| 原因 | 判定 |
|---|---|
| 流式消息从 partial 变 final | ✅ **是——content 漂移的机制**（但直接原因是并发，不是 partial→final 本身） |
| 消息对象原地更新 | ✅ **是——parts 原地更新是漂移机制**（同上，不是直接原因） |
| 截断游标归零 | ❌ 否（需 >200 条消息，Preview E2E 不可能达到） |
| 刷新重放 | ❌ 否（刷新后从 IndexedDB 读回的是 final 内容） |
| 跨标签页 | ❌ 否（本次 E2E 是单标签页；理论上是加剧因素但非触发原因） |
| createdAt fallback 漂移 | ❌ 否（`metadata.createdAt` 设定后不变） |

**直接根因是 `shadowChatSessions` 缺少并发互斥**，导致两次调用读取同一游标、发送同一 record ID，而 content 因流式增量揭示已不同。

### Q4: 是否可以在单测稳定复现？发生频率和影响范围？

**可以稳定复现。** 需延迟第一次 fetch 响应（模拟网络 I/O），在延迟期间更新消息内容，再发起第二次 `shadowChatSessions`。见 §5.2 伪代码。

频率：低——需防抖保存恰好在 partial 内容时触发、且网络 I/O 未完成时第二次保存触发。Preview E2E 仅观察到 1 条。

影响范围：仅 chat 影子写。quizAttempt 和 playback 不受影响。本地存储和用户体验不受影响。但一旦触发，该消息的游标永久卡住，后续所有 chat records 无法写入服务端。

### Q5: 最小处置建议？

**per-session mutex 串行化 `shadowChatSessions`**（方案 A）。仅改 `lib/runtime/shadow-writer.ts`，不改变 record ID 方案、服务端契约和 payload 结构。直接消除并发根因。

### Q6: 对 R3 的结论：仅 chat 阻断，还是通用幂等/outbox 设计也需调整？

**仅 chat 阻断。** 服务端幂等设计和通用 outbox 设计不需调整。playback 的 Dexie pending 模型是正确的参照实现。R3 通用 outbox 应以 playback 模型为模板，chat 需迁移到此模型后才能切读。

---

## 附录 B：Codex 评审勘误（2026-08-02）

> 本勘误由 Codex/负责人在调查报告初审后签署，修正以下 4 项过度结论，并给出拍板意见。原文中受影响的段落已在本勘误中逐项标注。

### B.1 content 漂移为高置信推断，非直接证据

**涉及原文**：§3.3"漂移字段是 `payload.content`"、§4.1 触发链路、§5.1-5.2 复现条件

**勘误**：现有日志仅证明"同一 record ID、不同内容"触发了服务端 409，**未保存两次请求的完整 body**。代码分析（`messageText` 流式增量揭示、`onTextReveal` 原地更新 parts、`echoMatches` 逐字段比对链路）高度支持 `payload.content` 漂移，且已逐一排除 `role`/`createdAt`/`sceneId` 和截断/刷新/跨标签页等替代假设。但：

- 尚未有实际运行的测试用例对比两次请求 body；
- §5.2 的伪代码仅为复现**方案**，未执行验证。

**修正**：原文中"漂移字段是 content""已确认""只有 content 不同"等断言应理解为**高置信推断，待门禁测试证实**。在门禁测试实际运行并抓取两次请求 body 之前，不得将 content 漂移作为已证事实写入 R3 设计稿的"已知条件"。

### B.2 mutex 仅消除并发 409，不保证 chat 数据完整性

**涉及原文**：§6.1"推荐方案：per-session mutex 串行化""立即（R2 观察期）：实施方案 A"、§6.3 推荐实施路径

**勘误**：报告自身已正确指出 mutex 的缺陷——第一次写入时消息可能仍为 partial（空字符串或不完整文本），mutex 推进游标后 **final 内容反而永远不会写入服务端**。对比两种状态：

| 状态 | partial 写入 | final 写入 | 日志表现 | 数据可切读？ |
|------|:---------:|:--------:|---------|:----------:|
| 无 mutex（当前） | ✅ | 409 → 游标卡死 | 红色（冲突遥测） | ❌ |
| 仅加 mutex | ✅ | ❌（游标已前进） | 绿色（无冲突） | ❌ |

**mutex 会让日志变绿，但 server 存储的仍是 partial 内容，不具备 R3 切读资格。** 因此：

- 撤销 §6.1 对 per-session mutex 的"推荐方案"评级（降为"并发缓解措施"）；
- 撤销 §6.3 第 1 条的"立即实施"建议 → 改为"暂不授权实施"；
- 原文 §1 摘要表中"最小处置：per-session mutex 串行化"需结合本勘误理解——它解决的是 409 冲突症状，不是数据完整性问题。

**chat 数据完整性的正式方案必须以 finalized-message 信号或持久化不可变 outbox 为核心**，mutex 最多作为该方案中的辅助并发控制手段。

### B.3 内存 mutex 不解决跨标签页

**涉及原文**：§4.4"排除的其他原因"表中"跨标签页：本次 E2E 是单标签页操作。理论上跨标签页共享 localStorage 游标可加剧问题，但不是本次触发原因。"

**勘误**：上述排除是合理的（本次 409 发生于单标签页 E2E）。但 §6.1 的 `Map<string, Promise<void>>` 实现仅在单个 JS 上下文内有效——两个标签页各自持有独立的内存 Map，仍共享 localStorage 游标，仍可能并发发送相同 record ID。因此：

- **per-session 内存 mutex 不是 chat 影子写的完整幂等保证**——它仅缓解单标签页内的并发问题；
- 跨标签页协调需要数据库事务、CAS（compare-and-swap）、PostgreSQL advisory lock 或等价的服务端协调机制；
- 这一约束应在 R3 通用 outbox 设计中一并处理，不应依赖客户端内存锁。

### B.4 对通用 outbox 的结论需修正

**涉及原文**：§7.1 核心结论表"通用 outbox 设计：不需调整"、§7.2 第 2 条

**勘误**：原文同时存在两个互相矛盾的表述——§7.1 称"通用 outbox 不需调整"，§7.2 第 2 条又要求 chat outbox 支持"内容更新/替代语义"和"新 record 替代旧 record"。正确结论应拆分为三层：

1. **服务端 `append_record` 幂等契约无需调整**——同 ID 同内容重放返回已有行、同 ID 不同内容返回 409，这是正确的幂等语义；
2. **playback pending 的核心原则成立**——"事务内生成 ID + 持久化冻结内容 + 条件确认后清除"是通用 outbox 的正确参照，但 **playback 的单行最新快照模型不能原样套给 chat**；
3. **chat 需要独立的 finalized-message outbox 设计**：chat 没有 playback 那样的"一次落盘对应一个稳定快照"——chat 的消息内容在流式揭示中持续变化，必须额外回答"消息何时 finalize"以及"finalized message 如何进入持久化 outbox"才能套用通用 outbox 模型。

### B.5 拍板结论

| 结论项 | 判定 |
|--------|------|
| R2/R2.1 签字 | ✅ 不受影响 |
| chat 409 为 R3 chat 切读阻断项 | ✅ 确认 |
| quizAttempt/playback 进入 R3 设计 | ✅ 可继续 |
| 授权实施 mutex 修复 | ❌ **暂不授权** |
| 启动 R3 总设计稿起草 | ✅ **可以开始**，但 chat 必须标为独立阻断分支 |
| R3 中 chat 可宣称 mutex 后即具备切读资格 | ❌ **不可**——chat 不得进入 server-preferred/server-primary，直至 finalized-message 或持久化 outbox 方案落地并已验证 |

**原调查报告状态**：正文保留原分析（作为调查推理过程的完整记录），本勘误为权威修正。凡原文与本勘误冲突之处，以本勘误为准。
