# 生产环境与课程视频导出交接（2026-09-02）

## 当前目标

恢复 `laixue.work` 正式环境登录与课程管理，并完成课程视频导出功能的正式验收。

## 代码状态

正式发布分支为 `main`。本轮相关提交按时间顺序：

- `175d4dc2`：课程管理页在视频任务接口失败时仍可显示课程。
- `b6994332`：尝试改为在运行时注入浏览器 Supabase 配置。
- `71d78533`：运行时配置兼容服务端 `SUPABASE_URL` / `SUPABASE_ANON_KEY`。
- `59ab7098`：空运行时配置不再使浏览器 Supabase 客户端初始化直接抛错。

视频导出主功能此前已在 Preview 验证：后台任务、互动页面跳过、按时间线串联音频/画面、课程管理显示进度和下载、编辑前要求保存到云端。

## 当前生产故障

`https://laixue.work/login?next=%2Fcourses` 登录提交显示 `Failed to fetch`。

根因已确认：Dokploy 的 Docker Swarm 发生不可修复 WAL 错误后进行了单节点重建。旧 Dokploy 环境变量和 Build-time Arguments 使用的加密 Secret 没有保留，控制台中因此显示 `env:1:...` / `enc:v1:...` 密文，应用容器得不到 Supabase 配置。

这不是账号密码问题。浏览器无法连接 Supabase，登录请求因而失败。

## 必须恢复的生产环境变量

在 Dokploy 的正式应用 **Environment** 中重建完整配置；不要在密文后追加。

### 项目对应关系（必须遵守）

- `rj-laixue-preview`（AWS `ap-southeast-1`，ref `ufwkylcsrppaamzqsvgx`）是 2026-07 建立的隔离 Preview/Scratch 项目，用于 Preview 验证与 SQL 演练。
- `zquanjin-wq's Project`（AWS `ap-northeast-1`）是正式环境应使用的 Supabase 项目。

两个项目不是重复创建：Preview 隔离是此前 RuntimeStore 验证的明确前提。正式应用严禁使用 Preview 的 URL、Publishable/anon key、service role key 或渲染地址。

最小登录所需：

```text
NEXT_PUBLIC_SUPABASE_URL=<zquanjin-wq's Project 的 Project URL>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<该正式项目的 Publishable key 或 legacy anon key>
SUPABASE_URL=<同一正式 Project URL>
SUPABASE_ANON_KEY=<同一正式项目的 Publishable key 或 legacy anon key>
```

完整运行还需要：

```text
SUPABASE_SERVICE_ROLE_KEY=<Production service role key>
TOKEN_PLAN_MINIMAX_API_KEY=<现有生产值>
TTS_MINIMAX_BASE_URL=<现有生产值>
VIDEO_RENDER_SERVICE_URL=<正式渲染服务 URL>
COURSE_VIDEO_EXPORT_URL=<正式应用的导出执行 URL>
CRON_SECRET=<与 Dokploy Schedule 一致的值>
```

`NEXT_PUBLIC_SUPABASE_URL` 的获取位置：进入 **zquanjin-wq's Project** 后点击 **Connect**，选择 Next.js 可复制 URL 与 Publishable key；也可在 **Settings → API Keys** 查看。不要使用 `rj-laixue-preview` 页面中的值。

Build-time Arguments 中的旧密文可清空。`59ab7098` 已让浏览器 Supabase 值从容器运行时注入，构建不再依赖这两个公开变量。

## 恢复顺序

1. 确认 Dokploy 控制台与 `dokploy-postgres` 均运行。
2. 清空 Build-time Arguments 的 `enc:v1:...` 内容并保存。
3. 用 Production 实际值重建正式应用 Environment；不要复制 Preview 的渲染 URL 到生产。
4. 部署 `main` 的 `59ab7098` 或更新提交。
5. 验收：登录、`/courses`、打开课程编辑器、保存后发起视频导出、后台完成、下载 MP4。

## Dokploy / 磁盘事件

- Docker Swarm WAL 曾损坏；重建解决了控制面，但使旧加密配置不可读。
- 2026-09-02 磁盘写满导致 Dokploy PostgreSQL 无法写 `postmaster.pid` / 恢复检查点，控制台返回 500。
- 已回收未使用 BuildKit 缓存 `15.72GB`、旧镜像 `2.02GB`；根盘从约 47--50GB 已用降至约 21GB 已用，约 27GB 可用；`dokploy-postgres` 已恢复。
- Docker 目录当前 `overlay2` 约 11GB；容器 JSON 日志和 Docker volume 均不是主要来源。
- “治理视频渲染磁盘占用”独立任务已恢复继续，负责长期缓存、日志、临时文件和容量保护方案；不要与主线混合部署。

## 安全告警

腾讯云告警路径为 `/proc/<pid>/root/app/dist/migration.mjs`，与 Dokploy 容器数据库迁移脚本和当时日志一致；该 PID 已退出，Dokploy 镜像为官方 `dokploy/dokploy:latest@sha256:9266374fb99fe6fc5b84ac4a9342270e0e0d00a2c1696660602276c92b81f6ce`。现有证据倾向安全产品对迁移脚本误报，未执行查杀。

## 注意

- 不要再次重建 Swarm、清空 Docker volume 或直接删除 `overlay2`。
- 不要把 Production 密钥写入 Git、聊天记录或交接文档。
- 用户明确要求：避免不现实的过度防御；不要引入 SHA/哈希方案。
