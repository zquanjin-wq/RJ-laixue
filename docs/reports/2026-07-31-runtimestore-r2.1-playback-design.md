# R2.1 playback 影子写前置设计卡（草案 v1，待评审）

> 来源：R2 验收时 playback 被移出 R2（cbfd3b91），Codex 拍板另立本卡；
> 本卡结论是 **R3 切读门禁的输入**（R3 总设计稿必须等本卡评审通过）。
> 状态：草案。未获批准前不改任何代码、不动 Preview/生产开关。

## 0. 本卡要回答的三件事（Codex 指定）

1. **pending/outbox**：弱网/离线时影子写如何排队、重试、幂等；
2. **刷新恢复**：刷新后本地与服务端各自怎么恢复、重试如何复用持久化 ID；
3. **跨标签页**：两个标签页同时播同一 stage 时的写入语义。

## 1. 现状盘点（2026-07-31 代码核实）

| 层 | 现状 |
|---|---|
| 引擎事件 | `PlaybackChromeRoot.tsx` 持有 `PlaybackEngine`，进度通过引擎回调推进 |
| 本地持久化 | **链路未接线（休眠代码）**：`savePlaybackState`/`loadPlaybackState` 无任何调用方；只有 `clearPlaybackState` 在删 stage 时（stage-storage.ts:254）被调用；`PlaybackChromeRoot.tsx:693` 的「恢复位置」是注释 TODO |
| Dexie 表 | `playbackState`：每 stage 一行（PK=stageId，put 覆盖），字段 `{sceneIndex, actionIndex, consumedDiscussions, updatedAt}`，**无 `runtimeShadowEventId`** |
| 影子写 | R2 验收修订时已**完全撤回**（含测试 `playback-shadow.test.ts` 一并删除），当前 shadow-writer 无任何 playback 代码 |
| 服务端 | `kind='playback'` 为 RJ app-owned，payload-validators 不做骨架校验（R2 设计稿 §1.3 已定） |

**关键含义**：R2.1 不是单纯"补影子写"——本地持久化链路本身先要接线并定义语义，
否则影子写没有可挂的持久化数据源（P0 要求 eventId 随快照落 Dexie，影子路径
**禁止**从调用方内存取数——沿用 R2 quiz 的同一条门禁）。

## 2. 范围拍板（请评审确认）

**建议 A（推荐）**：R2.1 = 本地持久化接线 + 影子写 + 最小 pending 重试，一次做完。
理由：三块互相依赖——影子写数据源是 Dexie 行（依赖本地接线），重试复用
eventId（依赖 pending 语义）。拆开做会产生中间态（影子写挂在内存数据上），
正是 R2 被拦下的原因。

**建议 B**：本地持久化接线（含恢复消费）先做，影子写另行。
理由：本地恢复本身有独立业务价值（刷新续播目前不工作）。

**本卡按 A 展开**；若评审选 B，§3–§5 中影子写部分顺延即可，本地部分不变。

## 3. 本地持久化接线设计

### 3.1 写入时机（拍板项）

引擎 `onProgress` 是高频回调（每个 action 推进都触发）。**不建议逐事件落盘**。

| 候选 | 说明 | 建议 |
|---|---|---|
| 节流落盘 | 每 5s 最多一次 + 关键事件（pause / stop / scene 切换 / complete / 页面隐藏 visibilitychange）强制落盘 | ✅ 推荐 |
| 仅关键事件 | 只在 pause/stop/切场景/完成时写 | 备选（崩溃丢进度最多一个场景） |
| 逐事件 | 每个 action 写一次 | 否决：IndexedDB 写放大，且影子写频率随之爆炸 |

complete 时调用现有 `clearPlaybackState(stageId)`（语义：播完不留断点）。

### 3.2 Dexie schema 变更

`PlaybackStateRecord` 增加可选字段 `runtimeShadowEventId?: string`。
Dexie 对新增非索引字段**无需 version bump**（现有表结构不变），旧行读出来
该字段为 undefined，影子路径按"无持久化 ID → 跳过影子写"处理（与 R2 quiz
envelope 读不到即跳过的门禁一致）。

### 3.3 恢复消费（接通 TODO）

`PlaybackChromeRoot.tsx:693` 的 TODO 接线：挂载时 `loadPlaybackState(stageId)`，
行存在且 `sceneId` 匹配当前场景 → 恢复 `sceneIndex/actionIndex/consumedDiscussions`，
**不自动播放**（现有注释语义保留）。sceneId 不匹配 → 丢弃该行。

## 4. 影子写设计

### 4.1 会话与记录形状（沿用 R2 设计稿 §1.3，不变）

- 一个 stage → 一个 `RuntimeSession`：`id = pb:<stageId>`，kind=`playback`，status 常 `active`；
- 每次落盘 → 一条 record：payload = 整份快照 `{sceneIndex, actionIndex, consumedDiscussions}`；
- **record id（P0，R2 终审已拍板）**：`pb:<stageId>:<runtimeShadowEventId>`，
  eventId 为每次保存**之前**生成的新 UUID，**随快照同一 `db.playbackState.put`
  落 Dexie**；重试只能复用已持久化的 id；下次保存必须生成新 id。
  内存单调计数器 `pb:<stageId>:<monotonic-n>` 已否决（刷新/跨标签页复用序号
  撞幂等键）。

### 4.2 影子写频率

与 §3.1 落盘时机 1:1 对齐——**影子写只挂在"落盘"这个动作之后**（读 Dexie 刚写入
的行），不挂引擎事件本身。这样天然继承节流，且满足"影子数据只从持久化读回"。

### 4.3 pending / outbox（必答问题 ①）

R2 期拍板"不做 outbox"；R3 切读前 outbox 是门禁。本卡为 playback 定义
**最小 pending 机制**，刻意做成 R3 总 outbox 的子集：

| 决策 | 方案 |
|---|---|
| 队列载体 | **不建新表**：pending 状态就是 `playbackState` 行本身 + 新字段 `shadowPending: true`（影子写成功后清除）。每 stage 只有一行，天然去重 |
| 重试时机 | ① 落盘后立即尝试一次；② 失败标 `shadowPending`，下一次落盘时顺带重试上一笔；③ 挂载恢复时若发现 `shadowPending` 行，补一次 |
| 重试 ID | 始终复用行内 `runtimeShadowEventId`，**重试不生成新 ID**（同一快照同一 ID）；只有新业务落盘才换新 UUID |
| 覆盖语义 | 若上一笔未送出而进度又推进：新落盘生成新 UUID 并覆盖行（旧快照的影子写**被放弃**）——快照语义下只保留最新状态，历史断点无业务价值；遥测计 `superseded` |
| 离线 | fire-and-forget 继承 R2：失败静默丢弃 + 遥测；pending 行等下次上线后的首次落盘/挂载自然带出 |
| 不做的事 | 不建通用 outbox 表、不做指数退避、不做跨 kind 队列——那是 R3 的事，本卡只保证 playback 单 stage 单行的最小正确性 |

### 4.4 刷新恢复（必答问题 ②）

- **本地**：§3.3 已定义（Dexie 行恢复位置，不自动播放）；
- **影子写**：刷新后挂载时发现 `shadowPending` 行 → 用行内 eventId 补写一次；
  无 pending 行 → 不补（上次成功写出的快照服务端已有）；
- **读源不动**：R2.1 期服务端数据**不参与恢复**，恢复永远读本地 Dexie；
  服务端 records 只供 R3 比对门禁使用。

### 4.5 跨标签页（必答问题 ③）

两个标签页播同一 stage 的现实场景（学员误开两个窗口）：

| 层 | 语义 | 依据 |
|---|---|---|
| 本地 Dexie | put 覆盖，后写赢——**接受互踩**（现状语义，本卡不改） | 每 stage 一行是既有设计 |
| 影子写 | **不产生幂等冲突**：各标签页各自生成 UUID，record id 不同，append 都成功 | UUID 方案天然免疫（这正是否决单调计数器的原因） |
| 服务端 records | 两标签页的快照**交错追加**；读时按 updatedAt 取最新即现状 | 快照语义下可接受；R3 切读门禁按"最新一条"比对即可 |
| 结论 | 跨标签页**不加锁、不加 lease** | 加锁的收益（records 不交错）不抵复杂度；若 R3 评审认为必须串行化，再议 |

## 5. 遥测

沿用 `runtime_shadow` 事件，op 新增 `append_record, kind=playback`；
outcome 在现有 ok / failure 之外，新增计数维度 `superseded`（被新快照覆盖
而放弃的 pending 笔数）——这是观察跨标签页/高频推进行为的关键指标。

## 6. 测试门禁（验收时必须全绿）

1. **eventId 持久化**：保存进度后刷新页面 → 触发重试 → 复用同一 eventId
   （注入第一次 5xx，断言第二次请求的 record id 相同）；
2. **覆盖语义**：连续两次落盘（第一次注入失败）→ 第二次生成新 UUID，
   旧 pending 被放弃，遥测计 superseded；
3. **挂载补写**：构造 `shadowPending` 行 → 重新挂载 → 自动补写一次且 id 不变；
4. **本地恢复**：保存 → 刷新 → 位置恢复且 sceneId 不匹配时丢弃；
5. **开关关闭零副作用**：`NEXT_PUBLIC_RUNTIME_SHADOW` 非 '1' 时不产生任何
   `/api/runtime/` 请求（含挂载补写路径）；
6. **complete 清理**：播完 → `playbackState` 行删除 → 无影子写、无残留 pending。

## 7. 与 R3 的接口（本卡的输出物）

R3 切读门禁评审时，本卡提供三个已验证结论：
1. playback 服务端 records 与本地 Dexie 行的一致性比对方法（取最新一条快照）；
2. `superseded` 率的观测数据（决定 R3 是否需要折叠/压缩策略）；
3. pending 机制作为 R3 总 outbox 设计的最小参照实现。

## 8. 明确不做

- 不改 R2 已签字的 chat / quizAttempt 任何代码；
- 不建通用 outbox 表、不做退避策略（R3）；
- 跨标签页不加锁；
- 不动 Preview/生产开关之外的任何控制面；不执行任何 SQL；
- 服务端恢复读源（读源切换是 R3）。
