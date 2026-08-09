# Chat Finalized-Message 生命周期调查报告

**日期**: 2026-08-09
**性质**: 只读调查——未修改任何代码

---

## 1. 结论一句话

**当前 Chat 没有明确的 "finalized message" 信号。** 消息内容在流式传输过程中持续增长（`StreamBuffer` 逐字推进），并被影子写入器在**任意中间状态**保存和发送——这是 IDEMPOTENCY_CONFLICT 409 的结构性根源。

---

## 2. 消息生命周期时间线

```
POST /api/chat → SSE stream:
  agent_start → text_delta* → text_end → agent_end → done
       ↓
  StreamBuffer（逐字推进，text_end → sealed=true）
       ↓
  agentLoop → reason: 'end' → session.status = 'completed'
       ↓
  debouncedSave → saveChatSessions → IndexedDB
       ↓
  shadowChatSessions（fire-and-forget，附加到 RuntimeStore）
```

---

## 3. 关键事实

### 3.1 无 finalized 信号

| 问题 | 事实 |
|------|------|
| 消息何时被认为 "完成"？ | 流结束时（`done` SSE 事件 + `sealed=true`），但**没有持久化的 finalized 字段** |
| 影子写入器等待 finalization？ | **不**。影子写入器在 `saveChatSessions` 成功后立即触发（`chat-storage.ts:56`）——此时 `debouncedSave` 可能因截断或其他操作在**流结束前**触发 |
| 消息有 `finalizedAt` 或 `isFinalized` 字段？ | **没有**。`UIMessage` 类型不包含此类字段 |

### 3.2 影子写入时内容可能未完成

- `debouncedSave` 在流结束前就可能触发（`use-chat-sessions.ts` 的 `scheduleSave`）
- 影子写入通过游标差分追加新消息，此时消息 `parts` 可能只是部分文本
- Lecture 消息尤其严重：只有一条消息 `lecture-msg-<ts>`，所有语音动作通过 StreamBuffer 逐个字追加到同一条消息
- 每次保存重新计算 `messageText(msg.parts)`（全量文本），lecture 内容随播放持续增长
- 因此同一 record ID `session:lecture-msg-<ts>` 在不同保存时刻有不同内容 → 409 IDEMPOTENCY_CONFLICT

### 3.3 消息从不替换或重新生成（确认）

- 不存在消息编辑/删除/替换函数
- `interrupted: true` 元数据标记中断，但消息保留原 ID
- `resumeSession` 继续同一会话，追加新消息（新 ID）
- `regenerateScene` 操作场景内容，不触及聊天消息

### 3.4 保存模式：全量覆盖 + 游标差分

```
saveChatSessions:
  db.chatSessions.where('stageId').equals(stageId).delete()
  db.chatSessions.bulkPut(records)
  → void shadowChatSessions(stageId, sessions)
      → 游标比较: 上次发送的 message 数 vs 当前 message 数
      → 只发送新增 message: for (cursor.count; i < messages.length; i++)
      → 每条: appendRecord(record with id=<sessionId>:<msg.id>)
```

---

## 4. Chat 进入 outbox/dual-read 所需的前置

| 需求 | 当前状态 |
|------|----------|
| 明确的 finalized-message 信号（`status: 'streaming' → 'finalized'`） | ❌ 不存在 |
| 内容不可变性承诺（finalized 后内容不再变化） | ❌ lecture 打破了这一点 |
| 持久化的 Chat outbox（类似 Playback/Quiz） | ❌ Chat 使用 direct shadow，不走 outbox |
| 完整 payload 契约（含 model/provider/scene/引用） | ❌ 仅 `{ role, content }` |

---

## 5. 建议

在设计 Chat outbox 之前（阶段 D），需要先解决：

1. 区分 `draft` 与 `finalized` 消息状态——在流结束、`done` 事件后标记消息为 finalized
2. 影子写入（或未来的 outbox）**仅发送 finalized 消息**——不从中间状态保存
3. Lecture 消息拆分为多条（M2 正解），每条独立录 ID 和不可变内容
4. 定义完整 payload contract（model/provider/scene/引用/完成原因/中断原因）

**当前警告**：在 finalized-message 信号落地前，Chat 不应进入 outbox 或 dual-read。继续使用 direct shadow + M1 IDEMPOTENCY_CONFLICT skip 保底。

---

**报告日期**: 2026-08-09
**调查人**: WorkBuddy / Explore agent
**审阅**: Kimi（Codex）
