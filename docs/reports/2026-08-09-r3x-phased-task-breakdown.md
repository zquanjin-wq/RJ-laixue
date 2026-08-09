# R3.x dual-read 分阶段任务分解

**日期**: 2026-08-09
**前置**: 阶段 A（生产 shadow 观察期）通过
**当前范围**: Playback + Quiz 首轮；**Chat 明确排除**
**状态**: DRAFT — 规划阶段，未授权实施

---

## 阶段总览

| 阶段 | 名称 | 范围 | 前提 |
|:--:|------|------|------|
| A | 生产 shadow 观察闭环 | Playback + Chat（已开启） | 🔄 进行中 |
| B | Quiz 生产受控上线 | Quiz（已签字，未开启） | A 通过 |
| C | 自动化运行监控 | 全 kind | B 通过 |
| D | Chat 可靠写模型 | Chat（另案，不在本分解） | 独立卡片 |
| **E** | **R3.x dual-read** | **Playback + Quiz 首轮** | **A+B+C 全通过** |
| F | 跨设备恢复 | 全 kind | E 稳定 |
| G | 学习智能层 | 全 kind | F 通过 |

---

## 阶段 E 详细分解（Playback + Quiz first）

### E1：Playback 双读基础设施

| # | 任务 | 产出 |
|---|------|------|
| E1.1 | Dual-read 开关与配置：`NEXT_PUBLIC_RUNTIME_DUAL_READ_PLAYBACK=1` 控制读源，默认仍 `local` | 配置 schema |
| E1.2 | 服务端 Playback session 读取 API：按 `stageId + tabOwnerId` 查询最近未完成 visit，返回 `{ visitId, sessionId, status, sceneIndex, actionIndex, ... }` | `/api/runtime/v1/sessions/recent-active` GET |
| E1.3 | 服务端 Playback records 读取 API：按 `sessionId` 返回 records 数组，按 `createdAt` 排序 | `/api/runtime/v1/sessions/{id}/records` GET |
| E1.4 | 客户端 `ReadPlaybackFromServer` 函数：读取服务端数据，构造 `PlaybackSnapshot`；失败时 `throw`，调用方 fallback 到本地 | `lib/runtime/playback-server-read.ts` |
| E1.5 | Dual-read compare：本地快照 vs 服务端快照，比较 `capturedAt + eventId` 判定新旧 | `lib/runtime/playback-dual-compare.ts` |
| E1.6 | 差异上报：比较结果（`match` / `server_newer` / `local_newer` / `error`）上报 `client-diagnostics`，暂不上屏 | diagnostic payload |
| E1.7 | 自动回退：server error 或 compare mismatch 超过阈值（> 10%）→ 自动降级到 `local` 读源 | 降级状态机 |

### E2：Quiz 双读基础设施

| # | 任务 | 产出 |
|---|------|------|
| E2.1 | Dual-read 开关：`NEXT_PUBLIC_RUNTIME_DUAL_READ_QUIZ=1` | 配置 |
| E2.2 | 服务端 Quiz attempt/session 查询：按 `attemptId` 查 session + all records | API |
| E2.3 | 客户端 `ReadQuizFromServer` | 函数 |
| E2.4 | Dual-read compare：按 attempt/phase contract 比对 | 函数 |
| E2.5 | 差异上报 + 自动回退（同 E1.7） | 集成 |

### E3：Dual-read 验收门禁

| # | 场景 | 期望 |
|---|------|------|
| E3-1 | 本地有数据、服务端有新数据 | `server_newer` 上报，不上屏服务端数据 |
| E3-2 | 本地无数据、服务端有数据 | `server_only` 上报，不上屏（仍用本地空） |
| E3-3 | 本地与服务端一致 | `match` 上报 |
| E3-4 | 服务端读取失败（网络/5xx/404） | `error` 上报，继续使用本地数据（零影响） |
| E3-5 | 差异率超过 10% | 自动降级到 local，上报 `degraded_threshold` |
| E3-6 | Quiz 严格链五段全对齐 | 所有 phase match |
| E3-7 | Playback completed 后新周期 session 正确识别 | session ID 含 visitId |

---

## 关键原则

1. **本地结果始终上屏**——dual-read 期间不改业务读源
2. **服务端只做后台读取和对比**——不影响用户交互
3. **Playback 按 `capturedAt + eventId` 判断新旧**——不依赖单一时间戳
4. **Quiz 按 `attempt/phase` contract 比对**——不按任意字段
5. **超阈值自动回退到 shadow**——不要求人工介入
6. **Chat 全程排除**——在 finalized-message 信号落地前不进入

---

## 不授权

- ❌ 实施阶段 E 任何代码——等待 A+B+C 全通过
- ❌ 修改任何读源——当前始终 local
- ❌ Chat dual-read
- ❌ server-preferred / server-primary 读源
- ❌ 跨设备恢复

---

**状态**: DRAFT — 规划阶段
**审阅**: Kimi（Codex）
**下一步**: 观察期结束后签署阶段 A → B 上线卡
