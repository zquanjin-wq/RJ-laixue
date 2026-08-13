# M0 基线报告：本地与公网可审计事实

**编号**: MIG-EO-M0-BASELINE  
**采集日期**: 2026-08-13  
**采集范围**: 仓库工作区、公开 DNS/TLS/HTTP 响应；未读取或记录任何 Secret。  
**状态**: 🟡 本地与公网部分完成；账号、ICP、平台权限和多运营商数据待外部补齐。

---

## 1. 发布基线

| 项目 | 采集结果 | 说明 |
|---|---|---|
| 当前分支 | `main` | 迁移代码不得直接混入该分支，建议从独立迁移分支开始。 |
| 当前 HEAD | `9c91979fb07a4e92207ebaaefb1ebe7f880ccf7b` | `fix: avoid unsupported Vercel cron deployment`。 |
| 工作区 | 已有未提交业务改动 | 本报告和迁移文档为新增文件；不得将既有改动误归入迁移。 |
| 项目声明 Node | `22` | 来自 `.nvmrc`。 |
| 当前本机 Node | `24.18.0` | 与项目声明不一致；M1 必须用 Node 20/22 复现构建，不以本机 Node 24 结果作为唯一依据。 |
| 当前本机 pnpm | `10.28.0` | M1 固定版本后再记录。 |
| API 路由数 | 82 | 完整清单见 `M0-route-inventory.csv`。 |
| Vercel 函数时限 | 默认 300 秒 | `vercel.json` 对 `app/api/**/*.ts` 配置。 |
| 显式 300 秒路由 | 11 | EdgeOne Cloud Functions 不能按原样承载，已标为 Worker 候选。 |

## 2. 生产公网快照

采集点为当前执行环境，不能代表中国三网体验；仅用于证明当前解析与上游链路。

| 项目 | 采集结果 |
|---|---|
| `www.laixue.work` IPv4 | `104.21.1.155`、`172.67.129.117` |
| IPv6 | `2606:4700:3037::ac43:8175`、`2606:4700:3030::6815:19b` |
| DNS TTL | 300 秒 |
| 权威 DNS | Cloudflare nameservers |
| `/api/health` | `200 OK`，响应显示 `Server: cloudflare`、`x-vercel-id`、`x-vercel-cache: MISS` |
| `/` | `200 OK`，响应显示 `Server: cloudflare`、`x-vercel-id`、`x-vercel-cache: HIT` |
| TLS | 证书主体 `CN=laixue.work`，Google Trust Services 签发，到期 `2026-10-18` |

**结论**：当前路径为“Cloudflare 代理 → Vercel”。M6 的 DNS 回退快照必须在切流日重新采集，不能直接使用本报告代替。

## 3. 运行时与迁移风险基线

- 本地路由追踪中 32 个 API 路由超过 115 MB，最大约 127.4 MB；EdgeOne 云函数 128 MB 限制使 M1 包体实测成为硬门禁。
- `audio-upload` 服务端接收音频且目标 bucket 限制为 50 MB；M4 必须改签名直传，不得把大文件压入 EdgeOne 请求。
- `parse-pdf` 及其依赖使用 `sharp`；该链路归属 Node Task Worker 候选。
- `generate-classroom`、课程重配音等使用 `after()` 或本地文件状态；M3 必须先完成持久任务改造。
- 当前本地 `.env.example` 中有 **99** 个变量名；环境变量矩阵见 `M0-environment-matrix.csv`，仅列名称和归类。

## 4. 外部待补齐项与阶段归属

| 编号 | 待补齐事实 | 所需角色 | 完成证据 |
|---|---|---|---|
| EXT-01 | EdgeOne Makers 账号、项目创建权限、日志权限 | 账号管理员 | 控制台可创建 Preview 项目 | **M1：✅ 账号 `100030044627` 可进入 Makers 并可见“创建项目”** |
| EXT-02 | `laixue.work` ICP 备案号、备案主体、可用加速区域 | 域名/合规负责人 | 备案查询与平台区域配置证据 | **M6：❌ 工信部查询为无备案；禁止中国大陆生产域名切流** |
| EXT-03 | DNS Registrar 和 Cloudflare Zone 的变更权限、回退记录 | DNS 管理员 | TTL/记录导出及变更授权 | **M6：🟡 用户确认拥有 Cloudflare 权限；切流日前仍需导出记录** |
| EXT-04 | Vercel Production/Preview 环境变量作用域与所有者 | Vercel 管理员 | 不含明文的名称/作用域清单 | **M1 前补齐 Preview 必需项；M6 前完整补齐** |
| EXT-05 | Vercel 近 30 天路由流量、p50/p95/p99、5xx、最长时长 | 运维负责人 | 导出报表 | **M5** |
| EXT-06 | 北京/上海/广州 × 电信/联通/移动访问基线 | 测试/网络负责人 | 原始探测数据与时间戳 | **M5：🟡 已收到全国/运营商/大区汇总，详见 `M0-performance-baseline.md`；城市级原始数据待补** |
| EXT-07 | EdgeOne 免费期后的商业条款、额度与结算主体 | 采购/账号管理员 | 控制台或书面答复 | **M7** |

## 5. M0 当前判定

- 本地清单、公开链路、环境变量名称矩阵：**已完成**。
- EdgeOne 账号 `100030044627` 已确认可进入 Makers 并可见“创建项目”；**M1 可以开工**。
- `laixue.work` 工信部查询为无备案：M1–M5 可继续，但 M6 不得配置中国大陆生产加速区或切换该域名。
- Cloudflare Zone 由用户管理；M6 前仍需重采 DNS 回退快照。
- 三网汇总响应基线已记录；Vercel 路由指标与城市级原始探测可在 M1–M5 并行补采。
