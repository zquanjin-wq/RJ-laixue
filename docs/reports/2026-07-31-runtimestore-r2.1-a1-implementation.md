# R2.1 A1 实施报告：playback 本地持久化接线（A1 SIGNED）

> **签字记录（Codex 2026-08-02 独立验证）**：6 个测试文件 44/44 通过；
> tsc 仅 4 个既有 pg/pg-mem 环境错误；idle 不触发 flush（不误伤 complete）；
> 未发现 A2 内容提前进入；工作树干净。**A1 正式签字**。
> 复审修复卡：f3223568（stop/teardown flush + 五类关键事件接线真实断言）。
> 另确立 A2 控制面约束（见 §5）。

> 设计卡：`2026-07-31-runtimestore-r2.1-playback-design.md`（v1.2，A1 已签字）
> 签字边界（Codex 2026-07-31）：仅限 Dexie 本地落盘与内存测试、5s trailing
> 节流及关键事件 flush、串行写入、引擎 cursor 恢复、completed 本地语义。
> **本实施不含 shadow writer / runtime API / eventId / pending / 遥测白名单 /
> 环境开关改动**——逐项自查见 §3。

## 1. 变更清单

| 文件 | 变更 |
|---|---|
| `lib/utils/playback-persistence.ts` | **新增**：`createPlaybackPersistence`（trailing 节流 / flush / complete / dispose + 写入串行化 promise 链）与 `resolveRestorablePlayback`（sceneId 定位、actionIndex 钳制、失效 discussion 过滤、completed 忽略） |
| `lib/utils/database.ts` | `PlaybackStateRecord` 新增可选字段 `sceneId?` / `capturedAt?` / `completed?`（非索引字段，无 version bump；**未加** A2 的 eventId/pending 字段） |
| `components/edit/PlaybackChromeRoot.tsx` | 接线：引擎 `onProgress` → schedule；`onModeChange` pause → flush；切 scene 顶部 flush；`onComplete` 末尾场景 → complete() 否则 flush；`visibilitychange→hidden` / `pagehide` → flush；per-stage 实例生命周期（卸载先 flush 再 dispose）；挂载恢复解析（一次性，两条路径均不自动播放） |
| `tests/playback/playback-persistence.test.ts` | **新增**：12 例，覆盖 A1 五条门禁 + 引擎游标往返 |
| `docs/reports/2026-07-31-runtimestore-r2.1-playback-design.md` | v1.2 勘误（§3.4 A1/A2 拆分、§4.3 重试/superseded 冲突消解）——先行提交 ad1997d9 |

## 2. 门禁结果（2026-07-31 本地）

| 门禁 | 用例 | 结果 |
|---|---|---|
| 1 trailing 节流 | 持续调度超过节流窗口 → 最终行最新快照（真实 fake-indexeddb）；窗口内 latest wins 只写一份 | ✅ |
| 2 强制 flush | flush 立即落盘不等窗口；空 flush 空操作 | ✅ |
| 3 写入串行化 | 慢写+快写并发 → 严格按入链顺序，旧写不超车 | ✅ |
| 4 恢复解析 | sceneId 定位 / actionIndex 钳制(99→2) / d-ghost 过滤 / sceneId 缺失丢弃 / 场景已删丢弃 / completed 忽略 | ✅ |
| 5 complete 语义 | completed:true 行保留不删、恢复忽略 | ✅ |
| 附 引擎游标 | restoreFromSnapshot/getSnapshot 往返，不自动播放 | ✅ |

- 专项：**tests/playback 12/12 通过**
- 回归：tests/lib/playback + tests/edit/stage-mode + tests/edit/regen-lock +
  tests/audio/audio-player-leak **25/25 通过**
- `tsc --noEmit`：本变更相关文件 0 error（仅 tests/runtime-store-pg 有 4 个
  预先存在的本地环境错误：缺 pg/pg-mem 包，与本变更无关，属 Codex 套件）

### 测试基建说明（评审须知）

1. `node_modules/fake-indexeddb` 根链接缺失（包在 .pnpm 仓内），已补目录联接——
   本地环境修复，不进仓库；
2. fake-indexeddb 与 `vi.useFakeTimers` 冲突（DB 操作挂起）：碰 Dexie 的用例
   一律真实计时器 + 短节流窗口（40ms）；只有写入被注入桩替换的纯逻辑用例
   用假计时器；
3. 恢复竞态处理：挂载恢复是异步解析，引擎可能已先于解析完成创建——实现
   覆盖两条路径（同场景直接 restoreFromSnapshot；异场景存 pendingRestoreRef
   切场景后由 scene-effect 应用）。

## 3. 签字边界自查

| 禁止项 | 状态 |
|---|---|
| shadow writer / runtime API 请求 | ✅ 未触碰（grep 无 playback 相关新增引用） |
| eventId / pending 字段与逻辑 | ✅ 未加入（database.ts 只加 sceneId/capturedAt/completed） |
| 遥测白名单 | ✅ 未触碰 |
| 环境开关 / SQL / 生产变更 | ✅ 未触碰 |
| beforeunload 依赖 | ✅ 未使用（仅 visibilitychange→hidden / pagehide） |
| 逐 action 落盘 | ✅ 否决落实（trailing 节流，窗口内 latest wins） |
| 自动播放 | ✅ 两条恢复路径均不调用 start() |

## 4. 已知边界（非阻断，评审知会）

- 断点场景为 quiz / interactive / pbl（无引擎）时：恢复只切场景不恢复游标
  （quiz 进度由 quiz 自身 localStorage 持久化负责，与 R2 一致）；
- 引擎按单场景构建（`[currentScene]`），row.sceneIndex 恒为 0——sceneId 是
  唯一定位主键，与设计卡 §3.3 一致；
- `resolveRestorablePlayback` 对旧行（无 sceneId）一律丢弃，不做 sceneIndex
  猜测性恢复（设计卡：sceneIndex 只作辅助）。

## 5. A2 控制面约束（Codex 2026-08-02 确立，A2 实施必须遵守）

- **playback 必须增加独立的默认关闭子开关** `NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK === '1'`；
  **总开关 `NEXT_PUBLIC_RUNTIME_SHADOW` 与子开关必须同时为真才发送**——
  原因：Preview 总开关已为 '1'，若 A2 只复用总开关，playback 代码一旦推送
  触发自动部署，会未经 A2 验收直接在 Preview 生效；
- A2 开发和部署期间子开关保持未设置/关闭，chat、quiz 观察不受影响；
- A2 本地门禁及代码验收通过后，再**单独申请** Preview 开启 playback 子开关；
- 生产开关、生产 SQL、生产部署继续禁止。
