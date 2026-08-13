# 来学平台迁移总规划：Vercel → EdgeOne Makers

**编号**: MIG-EO-2026-08
**制定日期**: 2026-08-13
**目标平台**: EdgeOne Makers（原 EdgeOne Pages）
**保底平台**: Vercel（迁移观察期内保留）
**状态**: 📝 待负责人批准开工
**预计工期**: 8–14 个工作日实施 + 7 天生产观察

---

## 1. 决策结论

采用“**EdgeOne 承载 Web 与短请求，独立 Node Worker 承载长任务与原生依赖**”的目标架构，不做未经验证的一次性全量搬迁。

首轮迁移保留 Supabase 数据库、认证和对象存储，避免同时迁移计算平台与数据平台。Vercel 在生产切流后至少保留 7 天，只有满足稳定性门禁后才允许下线。

## 2. 目标架构

```text
中国大陆/海外用户
        │
        ▼
EdgeOne Makers
  ├─ 静态资源、SSR、Middleware/Proxy
  ├─ 登录、课程、学习任务等短 API
  └─ 同域反向代理 ──────────────┐
                                ▼
                         Node Task Worker
                         ├─ PDF/sharp
                         ├─ 视频与批量配音
                         ├─ 课堂长任务
                         └─ 其他 >120s 工作
                                │
        ┌───────────────────────┘
        ▼
Supabase Auth / Postgres / Storage
```

## 3. 阶段与签字门

| 阶段 | 任务卡 | 目标 | 预计 | 生产影响 |
|---|---|---|---:|---|
| M0 | [迁移基线与前置条件](M0-baseline-and-preflight.md) | 建立基线、账号、域名和合规前提 | 0.5–1 天 | 无 |
| M1 | [EdgeOne 构建与运行 POC](M1-edgeone-poc.md) | 证明当前仓库能在 EdgeOne 构建和启动 | 1–2 天 | 无 |
| M2 | [平台可移植性改造](M2-platform-portability.md) | 清除 Vercel 假设并完成 EdgeOne 配置 | 2–3 天 | 无 |
| M3 | [持久任务与状态迁移](M3-durable-jobs-and-state.md) | 消除本地文件状态和不可靠后台任务 | 3–5 天 | Preview SQL |
| M4 | [上传链路与重负载拆分](M4-uploads-and-heavy-workloads.md) | 解决 6 MB、120 秒和原生模块限制 | 3–5 天 | 非生产 Worker |
| M5 | [EdgeOne Preview 全量验收](M5-preview-acceptance.md) | 完成功能、性能、故障与回滚验收 | 2–3 天 | Preview |
| M6 | [生产切流](M6-production-cutover.md) | 受控切换生产域名并保留快速回滚 | 1 天 | 有，需签字 |
| M7 | [稳定观察与 Vercel 下线决策](M7-stabilization-and-decommission.md) | 观察、结算并决定是否下线 Vercel | 7 天观察 | 有，需签字 |

任何阶段未签字，不得以“顺手完成”为由进入下一阶段的生产权限范围。

## 4. 已确认的硬约束

- EdgeOne Cloud Functions：请求/响应体 6 MB，默认 30 秒，最多 120 秒，代码包 128 MB。
- 当前有 11 个 API 声明 `maxDuration = 300`，不能直接按现状承载。
- 当前构建追踪中 32 个 API 路由超过 115 MB，最大约 127.4 MB，接近包体上限。
- `audio-upload` 允许约 50 MB 服务端中转，必须改为对象存储直传。
- 课堂生成任务使用 `after()` 和本地文件状态，必须改为持久任务模型。
- PDF 链路使用 `sharp`，不得迁到不支持原生模块的边缘运行时。
- 中国大陆区域的自定义域名需要 ICP 备案；备案未完成时只能先做境外/测试域名验证。

## 5. 总体验收指标

### 功能
- 关键用户旅程全部通过：登录、建课、编辑、上传材料、生成、保存、发布、学习、管理报表。
- 82 个 Route Handlers 完成“EdgeOne / Worker / 已废弃”三态归属，不允许遗漏。
- 所有长任务具备持久状态、幂等、失败重试和可观测错误。

### 性能与稳定性
- Preview 连续 24 小时无 P0/P1，生产切流后连续 7 天 5xx < 0.5%。
- 国内三网关键页面 p75 LCP 不高于 2.5 秒，或相对 Vercel 基线改善至少 30%。
- 普通 API p95 不劣于 Vercel 基线 20%；长任务以完成率和排队时间衡量。
- EdgeOne 上的同步请求不得依赖超过 100 秒的处理，保留 20 秒安全余量。
- 动态请求体不得超过 5 MB，保留 1 MB 协议与平台余量。

### 运维
- DNS/域名切换可在 15 分钟内回退。
- EdgeOne、Worker、Supabase 三处日志可用同一个 request/job ID 串联。
- 生产环境变量有清单、有所有者、有轮换记录，不从 Vercel 盲目复制废弃变量。

## 6. 总风险登记

| 风险 | 严重度 | 控制措施 | 关闭阶段 |
|---|---|---|---|
| EdgeOne 商业价格尚未公布 | 高 | M0 获取账号侧说明；M7 前不得注销 Vercel | M7 |
| 128 MB 包体余量不足 | 高 | M1 实测；M2 拆分重依赖，目标部署包留 20% 余量 | M2 |
| 300 秒接口超过 120 秒 | 高 | M4 迁入 Worker 或改异步任务 | M4 |
| `after()` 与本地文件状态丢失 | 高 | M3 改 Supabase 持久任务 | M3 |
| Supabase 跨境延迟仍存在 | 中 | M5 国内三网实测；必要时另立数据平台迁移项目 | M5 |
| ICP/大陆加速区未就绪 | 高 | M0 前置确认，不以境外测试结果冒充大陆验收 | M0 |
| 双平台版本漂移 | 中 | M6 设置发布冻结窗口和唯一 release commit | M6 |

## 7. 分支、环境与发布原则

- 建议迁移分支：`migration/edgeone`；未经授权不得直接修改生产分支。
- EdgeOne Preview 只连接 Preview Supabase；生产 Supabase 变更必须有独立 SQL 执行单。
- Vercel 与 EdgeOne 必须部署同一 release commit 后才能比较性能或切流。
- 所有平台配置尽量代码化；账号密钥只进入平台 Secret，不进入仓库和任务报告。
- 生产切流前 24 小时冻结架构改动；只允许迁移阻断修复。

## 8. 最终退出条件

只有同时满足以下条件，M7 才能提出 Vercel 下线申请：

1. EdgeOne 生产连续 7 天达到稳定性指标；
2. 至少完成一次演练式回滚，RTO ≤ 15 分钟；
3. EdgeOne 商业化/额度风险有可接受结论；
4. 账单、域名、ICP、证书、日志和告警责任人明确；
5. Vercel 不再承载生产流量，且无独占环境变量或部署能力。
