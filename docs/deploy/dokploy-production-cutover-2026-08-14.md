# laixue：Vercel → 腾讯云香港 CVM 生产切换记录

**切换日期：** 2026-08-14  
**状态：** 已完成并验收  
**主站运行位置：** 腾讯云香港 CVM / Dokploy

## 1. 本次变更

| 项目 | 切换后状态 |
| --- | --- |
| `https://laixue.work` | Cloudflare 代理 → 腾讯云香港 CVM 上的 Dokploy `laixue-web` 服务 |
| `https://www.laixue.work` | Cloudflare 代理 → 同一 Dokploy 服务 |
| `https://hk.laixue.work` | 直连腾讯云香港 CVM 的验收/排障入口（DNS only） |
| 应用容器端口 | `3000` |
| HTTPS 证书 | Let's Encrypt，由 Dokploy/Traefik 管理 |
| 数据、认证、对象存储 | 继续使用现有 Supabase；本次未迁移数据库 |

## 2. 已验证项

- `laixue.work` 可正常进入登录页。
- `www.laixue.work` 可正常打开“锐捷来学”。
- 两个正式域名均在 Dokploy 显示 **DNS Valid**、**HTTPS**、`Cert: letsencrypt`。
- PDF 识别、解析、课程内容生成已在新环境验收通过。

## 3. DNS 与证书配置基线

| 域名 | Cloudflare 记录 | 代理状态 | Dokploy 配置 |
| --- | --- | --- | --- |
| `laixue.work` | A → 香港 CVM 公网 IP | Proxied（橙云） | `/`、端口 `3000`、HTTPS、Let's Encrypt |
| `www.laixue.work` | A → 香港 CVM 公网 IP | Proxied（橙云） | `/`、端口 `3000`、HTTPS、Let's Encrypt |
| `hk.laixue.work` | A → 香港 CVM 公网 IP | DNS only（灰云） | 用于直连验收与排障 |

> CVM 公网 IP 仅保留在 Cloudflare/Dokploy 控制台配置中；本文不记录具体 IP、账号或任何密钥。

## 4. 回滚与观察

- Vercel 项目、环境变量和部署记录暂不删除，至少保留 7 天作为回滚备用。
- 如果主站出现无法恢复的故障：将 Cloudflare 中 `laixue.work` 与 `www.laixue.work` 恢复为切换前的 Vercel 记录，并关闭/移除 Dokploy 对应域名路由后复测。
- 观察期内优先通过 `hk.laixue.work` 区分“应用故障”和“Cloudflare/DNS/证书链路故障”。

## 5. 后续边界

- 本次完成的是**计算与部署平台迁移**，并不等同于 Supabase 迁移。
- 是否将 Supabase 迁往 AIDAP 或其他国内 BaaS，需作为独立项目评估、演练和切换，避免与生产承载变更叠加。
