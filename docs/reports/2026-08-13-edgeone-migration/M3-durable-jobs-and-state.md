# M3 任务卡：持久任务与状态迁移

**编号**: MIG-EO-M3  
**前置**: M2 签字  
**状态**: ⏸️ 待开工确认  
**预计**: 3–5 天  
**生产权限**: 仅 Preview SQL，需单独执行单

## 1. 任务目标

消除 Serverless 本地文件、进程内锁和 `after()` 长任务假设，使任务在实例重启、并发执行和重复请求下仍可恢复。

## 2. 必改范围

- `lib/server/classroom-job-store.ts`：本地 JSON 文件状态迁移到 Supabase。
- `lib/server/classroom-storage.ts`：课堂持久数据迁移到对象存储或数据库。
- `lib/server/usage-storage.ts`：本地 JSONL 用量记录迁移到数据库或可观测平台。
- `app/api/generate-classroom/route.ts`：`after()` 改为持久任务入队。
- `app/api/courses/[id]/revoice/route.ts`：轮询触发执行改为显式 claim/worker 模型。
- `app/api/cron/course-revoice/route.ts`：保留为受保护触发器或迁移到独立 Worker 调度。

## 3. 任务模型要求

- [ ] 状态至少包含 queued/running/succeeded/failed/cancelled、attempt、locked_until、error。
- [ ] 创建任务使用幂等键，重复请求不得重复扣费或重复发布结果。
- [ ] Worker 使用原子 claim；锁超时后允许恢复，禁止双执行覆盖。
- [ ] 失败支持有限重试和终态；不得无限自旋。
- [ ] 所有日志包含 `jobId`、`requestId`、`userId`（脱敏）和 attempt。
- [ ] API 创建任务后快速返回 202，客户端通过轮询或流式状态获取进度。

## 4. 门禁场景

1. Worker 在执行中被终止，任务可在锁过期后恢复。
2. 同一幂等请求并发两次，只创建一个任务。
3. 同一任务被两个 Worker claim，仅一个成功。
4. 第三方 API 超时后按策略重试并最终进入明确终态。
5. 结果写入成功但响应丢失，重试不会重复发布。
6. EdgeOne 与 Vercel 同时读取任务状态，结果一致。

## 5. 交付物

- Preview SQL migration 与回滚说明。
- 持久任务代码、单元测试和并发测试。
- `M3-job-migration-report.md`。
- 生产 SQL 执行草案；本阶段不得执行生产 SQL。

## 6. 边界与回滚

- ❌ 不删除旧本地实现，先通过 feature flag 双读或可逆切换。
- ❌ 不执行 Production SQL。
- 回滚优先关新任务入口；Preview 表保留取证，不做紧急 DROP。

