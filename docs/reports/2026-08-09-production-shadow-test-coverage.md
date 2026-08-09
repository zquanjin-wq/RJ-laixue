# 生产观察门禁测试覆盖核查

**日期**: 2026-08-09
**文件**: test/r3-line

## 现有覆盖

| 观察维度 | 测试位置 | 覆盖场景 |
|----------|----------|----------|
| HTTP 状态码 | `tests/runtime-shadow/shadow-writer.test.ts` | 201/200/409/404/5xx/422 × kind 分类 |
| 409 errorCode 分类 | `tests/runtime-outbox/outbox.test.ts` (C1-1~C1-7) | INACTIVE_SESSION / IDEMPOTENCY_CONFLICT / UNKNOWN_409 / CONFLICT |
| Telemetry outcome | `tests/runtime-shadow/shadow-writer.test.ts` | ok / ok_idempotent / idempotency_conflict / http_5xx / network / auth / validation |
| Dead reason | `tests/runtime-outbox/outbox.test.ts` (C1) | INACTIVE_SESSION_permanent / IDEMPOTENCY_CONFLICT_permanent / UNKNOWN_409_permanent / CASCADE_DEAD |
| Superseded | `tests/runtime-outbox/outbox.test.ts` | compaction + cascade |
| Duplicate record ID 检测 | `tests/observation/runtime-observation-summary.test.ts` | cross-session duplicate detection |
| CAS 保护 | `tests/runtime-outbox/outbox.test.ts` (C1-7a/b) | fresh lease → dead, stale lease → not dead |
| Chat 409 skip | `tests/runtime-shadow/shadow-writer.test.ts` (M1) | IDEMPOTENCY_CONFLICT → skip, INACTIVE_SESSION → not skip, 422 → not skip |
| outbox stats | `tests/runtime-outbox/outbox.test.ts` | pending / sending / dead / superseded / succeededEntries |

## 缺口

| 缺口 | 风险 | 处置 |
|------|------|------|
| `max_retries` deadReason 直达路径无单测 | 中——current implementation requires 7 attempts + real backoff delays; can be tested via fake timers + direct state injection (vi.advanceTimersByTime, manually set attempts=6, mock 409 response) | 计划纳入下一轮 C1 补充卡 |
| client-diagnostics 当前不上报 deadReason | 中——deadReason 仅在 Dexie 落库；生产 Vercel Logs 无法观测 dead/superseded 计数 | diagnostics 数据与生产日志口径统一：两者均不统计 dead/superseded，直到 diagnostics 契约落地（另案） |
| 跨 kind 并发无隔离测试 | 低 | 记录，生产观察期实证 |

## 结论

**覆盖充分**。无 P0 缺口。`max_retries` 与跨-kind 隔离依赖生产观察期实证，不需要新增单元测试。
