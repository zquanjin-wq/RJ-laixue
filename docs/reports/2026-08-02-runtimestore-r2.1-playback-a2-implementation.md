# R2.1 playback 影子写 A2 实施报告（复审卡修复版，待复验）

- 日期：2026-08-02（初版）/ 2026-08-02（复审卡修复）
- 分支：`test/documentstore-parity`
- 前置状态：A1 SIGNED（复审修复卡 f3223568 验收通过，44/44）；设计卡 v1.3；A2 初版 f2b532e1 暂不签字（Codex 复审卡 2026-08-02：3 个核心失败窗口 + 1 项遥测契约偏差）
- 授权边界（Codex 2026-08-02 A2 开工授权）：
  - 可开发 eventId、结构化 pending、条件清除、superseded、playback shadow writer 和测试；
  - **playback 独立子开关 `NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK`，与总开关同时为真才发送**；A2 开发/部署期间子开关保持未设置；
  - A2 本地门禁及代码验收通过后，再单独申请 Preview 开子开关；
  - 生产开关、生产 SQL、生产部署继续禁止。

## 1. 变更清单

| 文件 | 变更 |
|---|---|
| `lib/utils/database.ts` | `PlaybackStateRecord` 增加 `runtimeShadowEventId?: string`、`shadowPending?: { eventId; capturedAt }`（非索引字段，无需 Dexie version bump） |
| `lib/utils/playback-persistence.ts` | buildRow 每次业务落盘生成新 UUID，eventId+pending 与快照同一次 put（§4.3 不变量）；enqueue 落盘前 superseded 检测（仅在注册 onSuperseded 消费者时启用，A1 用例行为零偏移）；新增导出 `clearPlaybackPending`（eventId 条件清除 / completed 行物理删除）、`getPlaybackPendingInfo`（挂载补写检查）、`comparePlaybackSnapshotOrder`（capturedAt 定新旧 + eventId 字典序 tie-break，§4.5） |
| `lib/runtime/shadow-writer.ts` | `RuntimeShadowKind` 增加 `'playback'`；`RuntimeShadowOutcome` 增加 `'superseded'`（本地丢弃指标，非请求结果）；新增 `isPlaybackShadowEnabled()`（总开关 ∧ 子开关）；新增 `shadowPlaybackProgress(stageId)`（只从 Dexie 读回，禁止内存数据；A1 遗留行无 eventId 时升级补写再发；会话 `pb:<stageId>`，record id `pb:<stageId>:<eventId>`；成功后条件清除，completed 行物理删除）；新增 `reportPlaybackSuperseded()` |
| `app/api/client-diagnostics/route.ts` | `SHADOW_KINDS` 加 `'playback'`；`SHADOW_OUTCOMES` 加 `'superseded'` |
| `components/edit/PlaybackChromeRoot.tsx` | persistence 接线 `onPersisted` → `shadowPlaybackProgress`、`onSuperseded` → `reportPlaybackSuperseded`；挂载恢复 effect 内 pending 补写重试（只重试库中当前这笔，不重放已覆盖旧快照） |
| `tests/playback/playback-shadow-a2.test.ts` | 新建，8 例，覆盖设计卡 §6 门禁 6-11 + A1 遗留行升级 |

## 2. 门禁结果（设计卡 v1.3 §6）

| 门禁 | 结果 | 证据 |
|---|---|---|
| 6 刷新重试复用同一 eventId | ✅ | 5xx 失败后模拟刷新（vi.resetModules 新 JS 会话、同一 IDB），两次 append 的 record id 均为 `pb:<stageId>:evt-1` |
| 7 条件清除 | ✅ | 旧 eventId 清除返回 `'skipped'` 且新 pending 不动；当前 eventId 才 `'cleared'` |
| 8 superseded | ✅ | 第二次落盘覆盖未发送 pending → 遥测 outcome=`superseded` 恰 1 条，且 runtime API 调用为 0（不伪装成请求结果） |
| 9 快照新旧比较 | ✅ | capturedAt 定新旧；相同按 eventId 字典序 tie-break；与到达顺序无关 |
| 10 complete 语义 | ✅ | 影子成功 → 行物理删除 + 会话 PATCH completed；影子失败 → completed 行保留 pending 不删除 |
| 11 子开关门禁 | ✅ | 只开总开关、子开关未设置 → runtime API 与 client-diagnostics 全零 fetch；本地落盘不受影响 |
| 附加：A1 遗留行升级 | ✅ | 无 eventId 的 completed 行首次影子时补写 eventId+pending 再发送，成功后删除 |

测试汇总：
- `tests/playback`：27/27 通过（A1 12 + 接线 7 + A2 8）
- 回归：`tests/lib/playback`、`tests/edit/stage-mode`、`tests/edit/regen-lock`、`tests/audio/audio-player-leak`、`tests/runtime-shadow`：55/55 通过
- `tsc --noEmit`：仅 4 个既有 pg/pg-mem 环境错误（`tests/runtime-store-pg/*`），本次变更文件 0 错误

## 3. 双开关自查（授权边界核心）

- `isPlaybackShadowEnabled()` = `NEXT_PUBLIC_RUNTIME_SHADOW === '1'` **且** `NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK === '1'`；
- 子开关当前**未在任何环境设置**（本地 .env、Vercel 均未配置）；
- 因此本 commit 推送触发 Vercel Preview 自动部署后，playback 影子**不会生效**——chat/quiz 观察期不受影响（门禁 11 实测零 fetch）；
- A2 代码验收通过后，需单独申请在 Vercel Preview 设置 `NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK=1` 并 redeploy。

## 4. 设计对齐声明

- 幂等锚点纪律：影子路径只从 Dexie 读回 eventId/pending/快照，禁止调用方内存数据（与 R2 quizAttempt envelope 同款）；
- pending 不变量：快照、eventId、pending 同一次 Dexie put（buildRow）；发送成功只能条件清除（eventId 匹配才清，completed 行删除）；
- superseded 是本地丢弃指标，遥测 outcome 独立，分母不含它（§4.3/§5）；
- 「最新」按 capturedAt 判定，payload 携带 `v:1` + capturedAt；tie-break 稳定（§4.5）；
- A1 已签字语义不破坏：恢复后不得自动播放（本次未触碰恢复/播放路径，A1 12 例全绿）；
- capturedAt 类型可选的 legacy 缺口：shadow 侧回退 `updatedAt` 派生 ISO，保证确定性。

## 5. 未触碰（红线自查）

- R2 已签字的 chat/quizAttempt 影子路径：零改动（`tests/runtime-shadow` 全绿）；
- 生产任何开关 / SQL / 部署：未触碰；
- Preview 环境变量：未改动（子开关待验收后单独申请）；
- 恢复后自动播放、双读、读源切换、outbox 表：均未涉及（pending 复用 playbackState 行，未建新表）。

## 6. 复审卡修复（Codex 2026-08-02 A2 暂不签字卡，四项全部关闭）

| 复审卡条目 | 修复 | 新增受控竞态/失败窗口测试 |
|---|---|---|
| 1. 条件清除非原子，跨标签页可误清新 pending | `clearPlaybackPending` 改为 Dexie rw 事务：读取、比较、清除/删除同一事务内完成 | 「旧清除事务与新快照写入竞争 → 最终新 pending 必须存在」：两种交错顺序不变量均成立 |
| 2. legacy 升级读后写覆盖竞态 | `shadowPlaybackProgress` 升级改为事务内 CAS：重新读取；仅当前行仍无 eventId/pending 才升级；已被新快照替换则直接用新行，禁止写回旧副本；行已删则放弃本次影子 | 「影子升级 legacy 行与新快照落盘并发 → 新快照不得被旧副本覆盖」 |
| 3. completed PATCH 失败仍删本地 pending | `setSessionStatusShadow` 结果检查：PATCH 成功/幂等成功后才条件删除；失败保留 completed pending | 「append 成功 + PATCH 失败 → 行保留；PATCH 恢复后重试补偿删除」（原门禁 10 只注入 records 失败） |
| 4. source: local_drop 未进遥测 | 客户端 payload 加 `source: 'local_drop'`（reportPlaybackSuperseded）；服务端 SHADOW_SOURCES 白名单校验 + superseded 强制要求 source + 日志字段落地 | 门禁 8 补断言 source === 'local_drop' |

复审卡修复后门禁：
- `tests/playback`：30/30 通过（A1 12 + 接线 7 + A2 11，含 3 个新竞态/失败窗口用例）
- 回归：55/55 通过；合计 85/85
- `tsc --noEmit`：仍仅 4 个既有 pg/pg-mem 环境错误，本次变更文件 0 错误
- 子开关 `NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK` 继续保持在所有环境未设置
