# R3.x 分阶段任务分解（v1.1 SIGNED 控制面）

**日期**: 2026-08-09
**上位文档**: R3 v1.1 签字设计（服务端权威 phase 控制）——本文唯一权威
**前置**: 阶段 A（生产 shadow 观察期）通过
**当前范围**: Playback + Quiz 首轮；**Chat 明确排除——服务端强制 `shadow`**
**状态**: DRAFT — 规划阶段，未授权实施

---

## 控制面原则（源于 SIGNED v1.1 §9.2）

| 原则 | 含义 | 对应签字条款 |
|------|------|:--:|
| 服务端权威 | `GET /api/runtime/v1/config` 返回 per-kind phase；客户端不自行决定 | GC5 |
| 客户端缓存 config | `{ configVersion, kinds: { playback: { effectivePhase }, quizAttempt: { effectivePhase }, chat: { effectivePhase } } }` 缓存到 `configVersion` 变化或 `expiresAt` 到期 | GC6 |
| Chat 强制 `shadow` | 服务端 config 对 `chat` 只允许 `effectivePhase: 'shadow'`；不存在 bypass 路径 | GC7 |
| 管理员写入口 | `PATCH /api/runtime/v1/config` 写入 `runtime_config` 表，需校验 Supabase session → service_role 内部写入 | GC8 |
| 审计日志 | 每次 config 变更写入 `runtime_config_audit` 表：变更人、变更前 phase、变更后 phase、时间戳、原因 | GC9 |
| 本地始终上屏 | dual-read 期间服务端只后台读取对比，不上屏；客户端读源不变 | GC10 |
| 服务端控制回退 | 客户端不内置阈值；降级由服务端 PATCH config 切换 phase 实现 | §9.2 |

---

## 阶段总览

| 阶段 | 名称 | Playback phase | Quiz phase | Chat phase | 前提 |
|:--:|------|:--:|:--:|:--:|------|
| A | 生产 shadow 观察闭环 | `shadow` | `shadow` | `shadow` | 🔄 进行中 |
| B | Quiz 生产受控上线 | `shadow` | `shadow` | `shadow` | A 通过 |
| C | 自动化运行监控 | `shadow` | `shadow` | `shadow` | B 通过 |
| D | Chat 可靠写模型 | `shadow` | `shadow` | `shadow` | 独立卡片 |
| **E** | **R3.x dual-read** | **`dual-read-compare`** | **`dual-read-compare`** | **`shadow`** | **A+B+C 全通过** |
| F | server-preferred | `server-preferred` | `server-preferred` | `shadow` | E 稳定 |
| G | server-primary | `server-primary` | `server-primary` | `shadow` | F 通过 |

---

## 阶段 E 详细分解（Playback + Quiz `dual-read-compare`）

### 服务端

| # | 任务 | 产出 | 对应条款 |
|---|------|------|:--:|
| E-S1 | `GET /api/runtime/v1/config`：返回 per-kind phase JSON；Chat.phase 固定 `shadow` | API endpoint | GC5/GC7 |
| E-S2 | `PATCH /api/runtime/v1/config`：管理员变更 phase，写入 `runtime_config` 表 → 记录 `runtime_config_audit` | admin write path | GC8/GC9 |
| E-S3 | 服务端 Playback session/records 查询 API（仅 GET，不写） | per-kind read API | — |
| E-S4 | 服务端 Quiz attempt/records 查询 API（仅 GET，不写） | per-kind read API | — |

### 客户端

| # | 任务 | 产出 | 对应条款 |
|---|------|------|:--:|
| E-C1 | Config cache：首次请求 `GET /api/runtime/v1/config`，按 `configVersion` 缓存直到 `expiresAt` 到期；失败保留上次有效值 | `lib/runtime/config-cache.ts` | GC6 |
| E-C2 | Playback dual compare：本地快照 vs 服务端 visit+records，按 `capturedAt + eventId` 判定 `match / server_newer / local_newer / error` | `lib/runtime/playback-dual-compare.ts` | GC10 |
| E-C3 | Quiz dual compare：按 attempt/phase contract 比对 | 同上模式 | GC10 |
| E-C4 | Diagnostics 上报 compare 结果（不上屏，不修改本地数据） | diagnostic payload | — |

### 门禁（对应签字 GC5–GC10）

| # | 场景 | 期望 | 对应条款 |
|---|------|------|:--:|
| G1 | config 中 playback.phase=`dual-read-compare` | 客户端执行 compare，不上屏 | GC5 |
| G2 | config 中 playback.phase=`shadow` | 客户端回到纯 shadow | GC5 |
| G3 | Chat.phase 始终为 `shadow` | 客户端不执行 Chat compare | GC7 |
| G4 | 服务端 5xx / 网络错误 | 客户端使用上次缓存 config，不退到未知状态 | GC6 |
| G5 | config 过期（超过 `expiresAt` 未刷新） | 客户端退到 per-kind `shadow` 安全默认 | GC6 |
| G6 | 管理员 PATCH config 成功 | `runtime_config_audit` 记录变更 | GC9 |
| G7 | Playback completed 后新周期 | session ID 含 visitId，compare 正确区分 | — |

---

## 不授权

- ❌ 阶段 E/F/G 实施代码
- ❌ 任何 client-side `NEXT_PUBLIC_*` 环境变量
- ❌ Chat dual-read / server-preferred / server-primary
- ❌ 客户端自主降级逻辑
- ❌ SQL / RPC / RLS 修改

---

**状态**: DRAFT — 规划阶段
**审阅**: Codex
**依据**: R3 v1.1 SIGNED §9.2 / GC5–GC10
