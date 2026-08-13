# M1 任务卡：EdgeOne 构建与运行 POC

**编号**: MIG-EO-M1  
**前置**: M0 签字  
**状态**: ⏸️ 待开工确认  
**预计**: 1–2 天  
**生产权限**: 无

**执行检查点（M1-1，2026-08-13）**: EdgeOne 在严格 JSON 解析根 `tsconfig.json` 时失败；本地最小修复与 `pnpm build` 已通过，详见 `M1-poc-report.md`。等待受控提交后重试 Preview 部署。

## 1. 任务目标

用当前 release commit 建立最小 EdgeOne Preview，实测 Next.js 16、monorepo 构建、包体和运行时兼容性，先回答“能否部署”，暂不追求全功能通过。

## 2. 实施范围

首次控制台填写项见 `M1-console-setup.md`；完成首次部署后再进入下列 POC 验证。

- [ ] 从迁移分支导入 EdgeOne Makers，锁定 Node.js 20 与 pnpm 版本。
- [ ] 配置 `pnpm build`、根目录和 Preview 环境变量。
- [ ] 记录安装、postinstall、Next build、平台打包各阶段耗时。
- [ ] 获取每个 Cloud Function 的最终包体，而非仅使用本地 `.nft.json` 估算。
- [ ] 验证 App Router、SSR、Route Handlers、流式响应、Middleware/Proxy 和 `next/image`。
- [ ] 对 `sharp`、文件系统、`after()`、长连接和 Supabase 出站请求做定点探针。
- [ ] 建立至少 20 个关键路由的启动级 smoke test。

## 3. 必测路由

- `/api/health`
- `/api/access-code/status`
- `/api/courses`
- `/api/learning/verify`
- `/api/chat`
- `/api/agent/edit`
- `/api/parse-pdf`
- `/api/audio-upload`
- `/api/generate-classroom`
- `/api/generate/video`

其余路由由 M0 清单选取，覆盖 Supabase、流式、上传、原生模块和动态页面五类。

## 4. 交付物

- EdgeOne Preview URL 与 deployment ID。
- `M1-poc-report.md`：成功项、失败项、日志证据、构建时长、包体清单。
- `M1-compatibility-matrix.csv`：每个路由的 EdgeOne 运行结论。
- M2–M4 阻断项列表，按 P0/P1/P2 排序。

## 5. Go / No-Go 门禁

满足以下条件方可 Go：

1. 基础页面、SSR 和普通 Route Handler 可运行；
2. 构建在 20 分钟内完成；
3. 失败项均可通过 M2–M4 的已知改造路径解决；
4. 没有 EdgeOne 平台不支持且无替代方案的核心能力。

若核心 Next.js 产物无法稳定构建，立即 No-Go，回到 Cloudflare/腾讯云容器整体托管重新选型，不继续堆补丁。

## 6. 边界与回滚

- ❌ 不绑定生产域名，不使用生产 Supabase，不改生产 Secret。
- POC 改动只能存在迁移分支；删除 Preview 项目即可完整回滚。
