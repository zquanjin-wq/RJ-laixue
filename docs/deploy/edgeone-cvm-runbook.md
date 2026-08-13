# Laixue 生产部署：EdgeOne + 腾讯云 CVM

> 状态：第一版可执行基线  
> 数据层：继续使用现有 Supabase  
> 应用层：腾讯云 CVM + Docker Compose  
> 入口层：EdgeOne（完成源站验收后接入）

## 1. 当前部署拓扑

单机阶段运行两个容器：

- `laixue`：Next.js 16 standalone，Node.js 20；
- `caddy`：监听 80，反向代理到 Next.js，保留 SSE 流式响应。

Next.js 的 3000 端口不映射到公网。安全组只需放行 SSH 管理端口（限制来源 IP）和 HTTP/HTTPS 入口；接入 EdgeOne 后应进一步限制源站访问。

## 2. 服务器基线

首台预生产建议：

- 腾讯云 CVM，北京或上海；
- Ubuntu 24.04 LTS x86_64；
- 4 vCPU / 8 GB 内存；
- 100 GB SSD 云硬盘；
- 公网带宽至少 5 Mbps，按量或包月根据预估流量选择；
- 包年包月至少 3 个月，以满足腾讯云备案资源要求；
- 自动快照与基础云监控开启。

若构建镜像也放在服务器执行，8 GB 是建议下限。后续改为 CI 构建并推送镜像后，运行规格可根据监控下调或扩容。

## 3. 环境变量

在服务器仓库根目录：

```bash
cp .env.deploy.example .env.deploy
chmod 600 .env.deploy
```

从 Vercel 生产环境逐项复制正在使用的变量。不要复制到聊天、工单、Git 或镜像层。

特别说明：`NEXT_PUBLIC_*` 会在 `docker compose build` 时写入浏览器 bundle，因此更换这些值后必须重新构建镜像；服务端密钥只在容器启动时注入。

## 4. 构建与启动

所有 Compose 命令都显式加载部署变量：

```bash
docker compose --env-file .env.deploy build
docker compose --env-file .env.deploy up -d
docker compose --env-file .env.deploy ps
```

验证：

```bash
curl -fsS http://127.0.0.1/api/health
docker compose --env-file .env.deploy logs --tail=200 laixue caddy
```

只有 `laixue` 显示 healthy、健康接口返回成功并完成 P0 验收后，才能接入测试域名。

## 5. 发布新版本

每次发布使用唯一镜像标签，例如 Git commit：

```bash
LAIXUE_IMAGE_TAG=<commit> docker compose --env-file .env.deploy build laixue
LAIXUE_IMAGE_TAG=<commit> docker compose --env-file .env.deploy up -d laixue
docker compose --env-file .env.deploy ps
```

单机发布会有短暂重启窗口。生产进入稳定期后升级为双 CVM + ALB，才具备真正滚动发布能力。

## 6. 回滚

保留上一个已验收镜像标签。回滚时把 `LAIXUE_IMAGE_TAG` 指回旧标签并启动：

```bash
LAIXUE_IMAGE_TAG=<previous-commit> docker compose --env-file .env.deploy up -d laixue
```

回滚后必须重新检查健康接口和 P0 旅程。DNS/EdgeOne 回切只处理流量入口，不代替数据库和任务状态核对。

## 7. 本地数据风险

当前 `/app/data` 挂载到命名卷，保存课堂 JSON、课堂生成任务、媒体和用量日志。这只保证容器重建不丢失，不等于高可用或可靠备份：

- 每日备份该卷或对应宿主目录；
- 不允许同时启动两个写同一份本地数据的 Web 实例；
- 在升级为双实例前，必须把这些数据迁入 Supabase/对象存储或独立任务服务。

## 8. EdgeOne 接入原则

- 先使用测试子域名，不直接切生产域名；
- `/api/*`、登录、用户态页面默认不缓存；
- `/_next/static/*` 和带内容哈希的静态资源可长期缓存；
- SSE 路由必须关闭缓存与响应缓冲；
- 上传大小、回源读取超时至少覆盖现网最大值；
- 完成 ICP 备案后再启用中国大陆加速区；
- DNS TTL 在生产切换前提前降低，并保留 Vercel 回切记录。

## 9. P0 上线验收

1. 健康检查和版本信息；
2. 登录/访问码及 Cookie 会话；
3. 课程读取、保存、刷新后恢复；
4. AI SSE 首包、持续输出、取消和错误；
5. PDF/PPT/音频上传；
6. 课程生成任务、重新配音和状态查询；
7. 移动端学习与进度写入；
8. 管理端课程、教师、学生和学习任务；
9. 容器重启后数据与任务状态；
10. Vercel 流量回切演练。

## 10. 暂不执行

- 不迁移生产 Supabase 到 AIDAP；
- 不取消 Vercel；
- 不直接将生产域名切至未验收源站；
- 不启动第二个 Web 副本写本地 `/app/data`；
- 不把 IGA Pages 或邀测 veFaaS 放入生产关键路径。
