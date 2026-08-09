# R3.x 分阶段任务分解（v1.1 SIGNED 控制面）

**日期**: 2026-08-09
**上位文档**: R3 v1.1 签字设计（服务端权威 phase 控制）——本文唯一权威
**前置**: 阶段 A（生产 shadow 观察期）通过
**当前范围**: Playback + Quiz 首轮；**Chat 明确排除——维持 shadow**
**状态**: DRAFT — 规划阶段，未授权实施

---

## 控制面原则（源于 SIGNED v1.1）

| 原则 | 含义 |
|------|------|
| 服务端权威 | `GET /api/runtime/v1/config` 下发 `{ configVersion, effectivePhase, expiresAt }` |
| 客户端不自行决定阶段 | 客户端只缓存服务端响应，到期重新请求；禁止客户端 `NEXT_PUBLIC_*` 环境变量切换读源 |
| Chat 强制 shadow | 阶段 A–F 全程，Chat 不进入 dual-read 或 server-primary |
| 本地始终上屏 | dual-read 期间不改业务读源；服务端只在后台读取与比较 |
| 服务端控制回退 | 降级决策由服务端 config 切换 phase 实现，客户端不内置阈值 |

---

## 阶段总览

| 阶段 | 名称 | phase 值 | 前提 |
|:--:|------|----------|------|
| A | 生产 shadow 观察闭环 | `shadow` | 🔄 进行中 |
| B | Quiz 生产受控上线 | `shadow`（Quiz 子开关） | A 通过 |
| C | 自动化运行监控 | `shadow` | B 通过 |
| D | Chat 可靠写模型 | `shadow` | 独立卡片 |
| **E** | **R3.x dual-read** | **`dual-read-compare`** | **A+B+C 全通过** |
| F | server-preferred | `server-preferred` | E 稳定 |
| G | server-primary | `server-primary` | F 通过 |

---

## 阶段 E 详细分解（`dual-read-compare` phase）

### 服务端

| # | 任务 | 产出 |
|---|------|------|
| E-S1 | Runtime config API：`GET /api/runtime/v1/config`，返回 `{ configVersion, effectivePhase, effectiveAt, expiresAt, supportedKinds: ['playback','quizAttempt'] }`；Chat 不在 supportedKinds 中 | API endpoint |
| E-S2 | Phase 切换管理：由负责人通过 Supabase RPC 或 config 表行切换 phase + configVersion，客户端自动识别 | RPC/admin function |

### 客户端

| # | 任务 | 产出 |
|---|------|------|
| E-C1 | Config cache：本地缓存服务端 config，每次页面加载请求一次，按 `expiresAt` 刷新；失败时保持上次有效 config | `lib/runtime/config-cache.ts` |
| E-C2 | Playback 服务端读取：按 `stageId` 查服务端 visit + records（仅 GET，不写） | `lib/runtime/playback-server-read.ts` |
| E-C3 | Playback dual compare：本地快照 vs 服务端，比较 `capturedAt + eventId` → `match / server_newer / local_newer / error` | `lib/runtime/playback-dual-compare.ts` |
| E-C4 | Quiz 服务端读取 + compare（同 E-C2/C3，按 attempt/phase contract） | 同上模式 |
| E-C5 | Diagnostics 上报：compare 结果上报 `client-diagnostics`（kind × compareResult）；不上屏、不修改本地数据 | diagnostic payload |
| E-C6 | 本地始终优先：服务端读取失败不阻断；compare 差异仅记录 | safe-fallback |

### 门禁

| # | 场景 | 期望 |
|---|------|------|
| G1 | 服务端返回有效 config,phase=`dual-read-compare` | 客户端执行 compare，不上屏 |
| G2 | 服务端返回 phase=`shadow` | 客户端回到纯 shadow，不 compare |
| G3 | 服务端 5xx / 网络错误 | 客户端使用上次缓存 config，不降级 |
| G4 | config 过期（超过 `expiresAt` 未刷新） | 客户端退到 phase=`shadow` 安全默认 |
| G5 | Playback completed 后新周期 | session ID 含 visitId，compare 正确识别 |
| G6 | Quiz 五段严格链 compare | 全部 match |

---

## 阶段 F/G 前置条件（不在本分解范围）

- 阶段 E `dual-read-compare` 稳定（compare 无持续 mismatching > 5%）
- Chat 可靠写模型（阶段 D）**签字并生效**
- 负责人签署 server-preferred 切换授权卡

---

## 不授权

- ❌ 阶段 E/F/G 实施代码
- ❌ 任何 client-side `NEXT_PUBLIC_DUAL_READ_*` 环境变量
- ❌ Chat dual-read / server-preferred / server-primary
- ❌ 客户端自主降级逻辑（10% 阈值等——均属服务端 phase 切换职责）
- ❌ SQL / RPC / RLS 修改
- ❌ 跨设备恢复

---

**状态**: DRAFT — 规划阶段
**审阅**: Kimi（Codex）
**依据**: R3 v1.1 SIGNED 设计
