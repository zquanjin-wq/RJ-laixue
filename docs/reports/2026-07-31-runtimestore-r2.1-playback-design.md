# R2.1 playback 影子写前置设计卡（v1.2，A1 已签字开工）

> 来源：R2 验收时 playback 被移出 R2（cbfd3b91），Codex 拍板另立本卡；
> 本卡结论是 **R3 切读门禁的输入**。
> v1.1：按 Codex 2026-07-31 评审结论修订——范围拆 A1/A2 双门禁、pending
> 结构化、complete 语义修正、跨标签页「最新」定义、恢复流程落到稳定标识。
> v1.2：A1 签字（Codex 2026-07-31）后的两处非阻断勘误——§3.4 complete 的
> A1/A2 表述拆开（含 A1 遗留 completed 行的升级补写约定）、§4.3 重试时机
> 与 superseded 的冲突消解。
> 状态：**A1 已签字开工**（仅限：Dexie 本地落盘与内存测试、5s trailing 节流
> 及关键事件 flush、串行写入、引擎 cursor 恢复、completed 本地语义；
> 禁止 shadow writer / runtime API / eventId / pending / 遥测白名单 / 环境开关）；
> A2 架构已批准，A1 验收全绿后方可进入。

## 0. 本卡要回答的三件事（Codex 指定）

1. **pending/outbox**：弱网/离线时影子写如何排队、重试、幂等；
2. **刷新恢复**：刷新后本地与服务端各自怎么恢复、重试如何复用持久化 ID；
3. **跨标签页**：两个标签页同时播同一 stage 时的写入语义。

## 1. 现状盘点（2026-07-31 代码核实，Codex 已确认成立）

| 层 | 现状 |
|---|---|
| 引擎事件 | `PlaybackEngine` 每个 action 推进前触发 `onProgress(snapshot)`（engine.ts:447，高频） |
| 本地持久化 | **链路未接线（休眠代码）**：`savePlaybackState`/`loadPlaybackState` 零调用方；只有 `clearPlaybackState` 在删 stage 时（stage-storage.ts:254）被调用；`PlaybackChromeRoot.tsx:693` 恢复位置是注释 TODO |
| Dexie 表 | `playbackState`：每 stage 一行（PK=stageId，put 覆盖），字段 `{sceneIndex, actionIndex, consumedDiscussions, updatedAt}`，无 eventId/pending 字段 |
| 影子写 | R2 验收修订时已完全撤回，当前 shadow-writer 无任何 playback 代码 |
| 服务端 | `kind='playback'` 为 RJ app-owned，payload-validators 不做骨架校验 |

## 2. 范围（Codex 拍板：选 A，拆两个门禁阶段）

**A1（先做）**：接通本地落盘 + 刷新恢复 + 测试。
**A2（A1 验收通过后做）**：影子写 + 最小 pending。

两阶段同属本 R2.1 卡，但**禁止两条链路同时一次性上线**，以隔离故障。
A1 阶段影子写代码不得启用（开关保持非 '1' 时零请求的门禁不变）。

## 3. A1：本地持久化接线设计

### 3.1 落盘时机（Codex 已批准，含约束）

- **5 秒节流 + 关键事件强制 flush**：
  - 节流必须是 **trailing/latest snapshot**——持续播放不能导致最后状态永远不写；
  - 强制 flush 事件：`pause`、`stop`、切 scene、`complete`、
    `visibilitychange → hidden`、`pagehide`；
  - **不把 `beforeunload` 异步写入当作正确性保障**；
  - 否决逐 action 落盘（写放大）；否决"仅关键事件"（异常刷新丢失窗口过大）。
- **IndexedDB 写入串行化**：落盘请求排队执行，避免旧快照晚完成覆盖新快照。

### 3.2 Dexie schema 变更

`PlaybackStateRecord` 增加可选字段（非索引字段，**无需 version bump**，Codex 已同意）：

```ts
interface PlaybackStateRecord {
  stageId: string;            // PK
  sceneId?: string;           // 稳定场景标识（恢复定位主键）
  sceneIndex: number;
  actionIndex: number;
  consumedDiscussions: string[];
  updatedAt: number;
  capturedAt?: string;        // ISO 时间戳，快照捕获时刻（A2 影子写同用）
  completed?: boolean;        // §3.4：播完标记，不参与本地续播
  // ── A2 新增（影子写）──
  runtimeShadowEventId?: string;
  shadowPending?: { eventId: string; capturedAt: string };
}
```

旧行读出新增字段为 undefined，按各字段语义分别降级处理。

### 3.3 恢复流程（阻断点 ④：落到稳定标识和引擎游标）

`PlaybackChromeRoot.tsx:693` TODO 接线，恢复顺序：

1. **先加载课程场景列表**，再按 **`sceneId` 验证和定位**快照所属场景；
   `sceneIndex` 只作辅助校验，不作定位依据（场景可能增删改序）；
2. 校验 `actionIndex` 在该场景 action 序列范围内，越界则钳制/丢弃；
3. `consumedDiscussions` 过滤已失效的 discussion ID（课程编辑后可能不存在）；
4. **恢复的是播放引擎内部 cursor**（`engine.restore(...)` 或等价 API），
   不只是 React UI 状态；
5. `completed: true` 的行**忽略**，不参与续播；
6. 恢复后**不得自动播放**（现状语义保留）。

### 3.4 complete 语义（阻断点 ①：不能直接清行）

播完**不再直接 `delete`**（v1.2 勘误：A1/A2 表述拆开）：

1. complete 时先保存一份 `completed: true` 的最终快照：
   - **A1**：只保存 `completed: true` 最终本地快照——A1 没有 eventId/pending；
   - **A2**：complete 时才将 eventId、pending 与最终快照**同一次 put**；
2. **A2 影子写成功后才物理删除该行**；A1 阶段（无影子写）complete 行保留，
   恢复逻辑按 §3.3-5 忽略；
3. **A2 遇到 A1 遗留的 completed 行**：上线后首次挂载/落盘时**升级补写**——
   为该最终快照生成 eventId 并发起一次影子写，成功后物理删除；
   不得永久残留；
4. 恢复、导出、比对路径遇到 `completed` 行一律按"已播完"处理，不作断点。

## 4. A2：影子写设计

### 4.1 会话与记录形状（沿用 R2 设计稿 §1.3，Codex 已同意）

- 一个 stage → 一个 `RuntimeSession`：`id = pb:<stageId>`，kind=`playback`，status 常 `active`；
- 每次落盘 → 一条 record，payload：

```ts
{
  v: 1,                          // payload 版本（阻断点 ③）
  sceneId: string,               // 稳定场景标识
  sceneIndex: number,
  actionIndex: number,
  consumedDiscussions: string[],
  capturedAt: string,            // 快照捕获时刻，「最新」的唯一判据
}
```

- record id：`pb:<stageId>:<runtimeShadowEventId>`（UUID 随快照同一次 Dexie put
  持久化；内存单调计数器已在 R2 终审否决）。

### 4.2 影子写挂点

只挂在「落盘」动作之后——读 Dexie 刚写入的行发起影子写，天然继承节流，
且满足"影子数据只从持久化读回，禁止调用方内存数据"（沿用 R2 quiz 门禁）。

### 4.3 pending（阻断点 ②：结构化 + 条件清除）

复用 `playbackState` 行，**不建新表**，但不是松散布尔：

```ts
shadowPending?: { eventId: string; capturedAt: string }
```

**不变量**：
- 快照、`runtimeShadowEventId`、`shadowPending` 必须**同一次 Dexie put** 持久化；
- 发送成功后**只能条件清除**：仅当数据库当前行的 `runtimeShadowEventId ===`
  已发送的 eventId 时才清除 pending——否则旧请求晚成功会误删已覆盖进去的
  新 pending（跨标签页/本标签页重试共用此约束）；
- 重试**复用行内 eventId，不生成新 ID**；只有新业务落盘才换新 UUID；
- **superseded**（Codex 已批准）：新快照覆盖未发送的旧快照时放弃旧 pending
  并计数——这是**本地丢弃指标**，不得伪装成一次服务端 shadow 请求结果上报；
- 重试时机（v1.2 勘误，消除与 superseded 的冲突）：① 落盘后立即一次；
  ② 失败标 pending，**挂载/恢复时重试当前 pending**；
  ③ **新业务快照到来时：旧 pending 直接计 superseded，保存并发送新快照——
  不为了旧快照阻塞新进度落盘**，不再称为"重试旧笔"；
- 离线：fire-and-forget 继承 R2，失败静默 + 遥测；pending 等上线后首次
  落盘/挂载自然带出；
- 不做：通用 outbox 表、指数退避、跨 kind 队列（R3 的事）。

### 4.4 刷新恢复（A2 部分）

- 本地：§3.3；
- 影子写：挂载发现 `shadowPending` 行 → 用行内 eventId 补写一次；无 pending 不补；
- 读源不动：服务端数据**不参与恢复**；服务端 records 仅供 R3 比对门禁。

### 4.5 跨标签页（有条件批准不加锁，阻断点 ③）

「UUID 不冲突」只解决 record ID 幂等，不能独自解决竞争。必须同时具备：

1. **eventId 条件确认**（§4.3）：防止标签页 A 的旧请求成功后清掉标签页 B
   的新 pending；
2. **payload 含 `capturedAt`**：不同网络延迟导致服务端 append 顺序 ≠ 快照
   新旧顺序，「最新状态」**明确按 capturedAt 判断，不按 append 到达顺序，
   不靠服务端 seq**；
3. **稳定 tie-break**：`capturedAt` 相同时按 `runtimeShadowEventId` 字典序
   取大者（确定性、全端一致）；
4. 两个标签页覆盖同一 Dexie 行：接受后写赢（现状语义），配合条件清除保证
   pending 不被误删；
5. **门禁测试**（新增）：「旧请求晚成功不清新 pending」+「双标签页交错写入
   后按 capturedAt 取最新」。

## 5. 遥测

沿用 `runtime_shadow`，op 新增 `append_record, kind=playback`；
`superseded` 只作本地计数维度上报（`source: local_drop`），不混入服务端
请求结果 outcome。

## 6. 测试门禁

**A1 验收门禁**：
1. 节流 trailing：持续播放 12s 不停 → 最终状态落盘；
2. 强制 flush：pause / 切 scene / `visibilitychange→hidden` / `pagehide` 各触发落盘；
3. 写入串行化：慢写 + 快写并发 → 最终行是新快照；
4. 恢复：落盘 → 刷新 → 按 sceneId 定位、actionIndex 校验、失效 discussion 过滤、
   引擎 cursor 恢复、不自动播放；`completed` 行被忽略；
5. complete（A1）：播完 → 行保留且 `completed: true`，恢复忽略。

**A2 验收门禁**（在 A1 全绿后执行）：
6. eventId 持久化：注入第一次 5xx → 刷新 → 重试复用同一 eventId；
7. 条件清除：旧请求晚成功 → 新 pending 不被误删（§4.3）；
8. superseded：连续两次落盘（第一次注入失败）→ 新 UUID 覆盖，旧 pending 放弃，
   遥测为 local_drop 而非服务端结果；
9. 双标签页交错：两上下文交错写入 → 按 capturedAt（含 tie-break）取最新；
10. complete（A2）：播完 → completed 快照影子成功 → 行物理删除；
11. 开关关闭零副作用：非 '1' 时全程无 `/api/runtime/` 请求（含挂载补写）。

## 7. 与 R3 的接口（本卡输出物）

1. playback 服务端 records 与本地行的一致性比对方法：**按 capturedAt 取最新**
   （含 tie-break），不看 append 顺序；
2. `superseded` 率观测数据（决定 R3 是否需折叠/压缩策略）；
3. pending 机制作为 R3 总 outbox 设计的最小参照实现。

## 8. 明确不做

- 不改 R2 已签字的 chat / quizAttempt 任何代码；
- 不建通用 outbox 表、不做退避（R3）；
- 跨标签页不加锁（以 §4.5 五条为前提）；
- A1/A2 不一次性同时上线；
- 不引入服务端读取、不改变本地读源；
- 不动 Preview/生产开关之外的控制面；不执行任何 SQL；生产红线不变。
