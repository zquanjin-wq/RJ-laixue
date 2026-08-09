# RuntimeStore 生产 Shadow 七天观察期报告

**观察周期**: 2026-08-09 00:00 UTC+8 ~ 2026-08-16 00:00 UTC+8（七个完整观察日：08-09 至 08-15；08-16 出最终报告）
**观察执行**: WorkBuddy（数据整理）/ **决策与签字**: 负责人拍板、Kimi（Codex）验收
**前置**: R2 Chat 影子写 ✅、R3.1 Playback outbox ✅ 均已生产开启；R3.2 Quiz outbox 生产未开启
**状态**: 🔄 观察中

---

## 1. 观察对象

| 维度 | 覆盖范围 | 观察方式 |
|------|----------|----------|
| Runtime HTTP 状态码 | 所有 runtime API | Vercel Logs 汇总 |
| 409 errorCode 分类 | INACTIVE_SESSION / IDEMPOTENCY_CONFLICT / CONFLICT | Vercel Logs 汇总 |
| runtime_shadow telemetry outcome | ok / ok_idempotent / idempotency_conflict / http_5xx / network / auth / validation | Vercel Logs 汇总 |
| 重试次数 | attempts ≥ 3 的条目 | 人工检查 |
| dead/superseded 条目 | 客户端 outbox 状态 | 无法直接观察（仅客户端） |
| 可疑重复 ID | 同一 session:record 多次出现 | 汇总脚本检测 |
| 本地课堂体验 | 用户正常聊天/播放/答题 | 人工冒烟（负责人） |

---

## 2. 每日观察表

> 数据来源：人工导出的脱敏 Vercel Logs（`/api/runtime/v1/*` + `/api/client-diagnostics` 路径）。
> 分析脚本：`scripts/runtime-observation-summary.ts`（各列自动填充，本表手动填写）。

### Day 1 — 2026-08-09（六）

| 指标 | 数值 | 判定 |
|------|------|:--:|
| Runtime 请求总数 | — | — |
| 2xx | — | — |
| 4xx | — | — |
| 5xx | — | — |
| 409 INACTIVE_SESSION | — | — |
| 409 IDEMPOTENCY_CONFLICT | — | — |
| 409 CONFLICT | — | — |
| telemetry ok | — | — |
| telemetry idempotency_conflict | — | — |
| telemetry http_5xx / network | — | — |
| Playback completed 后追加 | — | — |
| 异常 / 备注 | — | — |

### Day 2 — 2026-08-10（日）

| 指标 | 数值 | 判定 |
|------|------|:--:|
| … | — | — |

### Day 3 — 2026-08-11（一）

| 指标 | 数值 | 判定 |
|------|------|:--:|
| … | — | — |

### Day 4 — 2026-08-12（二）

| 指标 | 数值 | 判定 |
|------|------|:--:|
| … | — | — |

### Day 5 — 2026-08-13（三）

| 指标 | 数值 | 判定 |
|------|------|:--:|
| … | — | — |

### Day 6 — 2026-08-14（四）

| 指标 | 数值 | 判定 |
|------|------|:--:|
| … | — | — |

### Day 7 — 2026-08-15（五）

| 指标 | 数值 | 判定 |
|------|------|:--:|
| … | — | — |

---

## 3. 异常记录

| 日期 | 时间（UTC+8） | 描述 | 影响面 | 根因 | 处置 | 关闭 |
|------|---------------|------|--------|------|------|:--:|
| — | — | — | — | — | — | — |

---

## 4. 回滚条件

以下任一条件触发，**立即关闭 Runtime 生产影子（`NEXT_PUBLIC_RUNTIME_SHADOW=0`，重新部署）**，本地课堂不受影响：

| # | 条件 | 判定来源 |
|---|------|----------|
| R1 | Playback outbox 出现 completed 后 409 INACTIVE_SESSION 且非残余窗口（> 3 条/天） | Vercel Logs |
| R2 | Runtime 5xx > 5% of total requests 持续 > 1h | Vercel Logs |
| R3 | 本地课堂体验回归——用户报告无法聊天/播放/答题 | 负责人人工判定 |
| R4 | 任何 P0 数据完整性问题——服务端数据与本地不一致且无法用现有原因解释 | 人工调查 |
| R5 | Supabase 数据库异常（连接失败/RPC 权限变更/RLS 策略变更） | Supabase Dashboard |

---

## 5. 最终 GO/NO-GO 判定模板

> 本表格在 2026-08-16 观察期结束后填写，由 Kimi 签字生效。

### Playback（R3.1 outbox，生产已开启）

| 准则 | 状态 | 证据 |
|------|:--:|------|
| 7 天内无 P0/P1 数据完整性问题 | ⬜ | — |
| completed 后追加的 INACTIVE_SESSION 409 ≤ 残余窗口预期 | ⬜ | — |
| outbox 无持续积压（最长 pending > 24h = 异常） | ⬜ | — |
| 所有 409 原因可解释 | ⬜ | — |
| 本地课堂无回归 | ⬜ | — |
| **Playback GO/NO-GO** | **⬜** | — |

### Chat（R2 shadow，生产已开启）

| 准则 | 状态 | 证据 |
|------|:--:|------|
| 7 天内无 P0 数据完整性问题 | ⬜ | — |
| IDEMPOTENCY_CONFLICT 全部可解释（lecture 内容增长 / M1 止血前） | ⬜ | — |
| 本地课堂无回归 | ⬜ | — |
| **Chat GO/NO-GO** | **⬜** | — |

### Quiz（R3.2 outbox，生产未开启）

| 准则 | 状态 | 证据 |
|------|:--:|------|
| 不适用——生产子开关未开启 | — | — |
| **Quiz GO/NO-GO** | **⬜** | 等待阶段 B 上线卡 |

---

## 6. 签字

| 角色 | 签字 | 日期 |
|------|:--:|------|
| 负责人（决策与拍板） | ⬜ | — |
| Kimi（Codex 验收） | ⬜ | — |
| WorkBuddy（数据整理，不签字） | — | — |

---

**报告日期**: 2026-08-09
**版本**: v0.1（待逐日填入）
