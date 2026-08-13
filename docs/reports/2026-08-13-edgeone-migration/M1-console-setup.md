# M1 EdgeOne Makers Preview：控制台配置单

**用途**: 首次 Preview POC。此配置不绑定生产域名、不写入生产 Secret、不代表中国大陆生产可用。  
**依据**: EdgeOne Makers Git 导入与 Next.js 框架文档；项目当前 `package.json`、`pnpm-lock.yaml` 和 `next.config.ts`。

## 1. 创建项目

1. EdgeOne Makers → **创建项目** → 连接 GitHub。
2. 选择仓库：`zquanjin-wq/RJ-laixue`。
3. 部署分支：`main`；第一次 POC 先用远端现有提交，不把本地未提交改动混入。
4. 框架：选择或确认自动识别为 **Next.js**。
5. 加速区域：选择**全球可用区（不含中国大陆）**或控制台提供的等价非大陆区域。

当前 `laixue.work` 无 ICP 备案；不要选择用于大陆生产域名的区域，也不要添加 `laixue.work` 自定义域名。

## 2. 构建设置

| 字段 | M1 值 | 说明 |
|---|---|---|
| Root Directory | `.` | 仓库根目录为 Next.js 与 pnpm workspace 根。 |
| Install Command | 平台自动识别 pnpm；如需手填，使用 `pnpm install --frozen-lockfile` | 保持 lockfile 可复现，禁止 `pnpm@latest`。 |
| Build Command | `pnpm build` | 包含 workspace postinstall 和导入器断言。 |
| Output Directory | `.next` | Next.js 默认产物；若平台自动接管则保留自动值。 |
| Node.js | 优先 Node 22；若平台仅提供 Node 20，记录为 POC 偏差并继续验证 | 项目声明 `>=20.9.0`，本地 `.nvmrc` 为 22。 |

## 3. M1 Preview 环境变量

首次只验证构建时，可先不设置密钥。若需要验证登录或调用 API，在 **Preview** 环境中由项目负责人直接录入对应 Preview 值；不得粘贴到聊天、文档或 Git。

最小功能验证通常需要：

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`（仅服务端管理 API）
- `ACCESS_CODE`（如启用访问码）

AI、TTS、PDF、图像和视频提供商密钥只在对应 M1 路由验证前添加，按最小权限、最小集合配置。

## 4. 首次部署后必须回传的非敏感信息

- Preview URL 与 deployment ID。
- 构建是否成功、总耗时、失败阶段。
- 失败日志中错误类型与不含 Secret 的前后 20 行。
- 平台展示的 Framework、Node 版本、每个 Function 的包体/运行时信息。

## 5. 禁止事项

- 不绑定 `laixue.work`、不修改 Cloudflare DNS、不开中国大陆生产区域。
- 不导入 Production Supabase 或 Production 提供商密钥。
- 不取消 Vercel 部署、域名或账单。

