# 独立课程视频渲染节点

一个渲染节点包含两项服务：`video-export-worker` 领取数据库任务，`render-service`
在本机 Chromium/FFmpeg 中完成一门课程的视频渲染。每个节点固定只运行一个视频，
通过数据库租约协调，不会重复领取同一任务。

## 扩容方式

1. 先在新服务器建立与主库的**私有网络**连接（VPC、WireGuard 或受控数据库代理）；不要将 PostgreSQL 公网暴露。
2. 为该节点配置仅包含 `DATABASE_URL`、腾讯云 COS 凭证与渲染配置的 `.env`。
3. 从同一版本代码构建并启动 `render-service` 与 `video-export-worker`。
4. 在主站设置 `COURSE_VIDEO_EXPORT_QUEUE_ENABLED=true`，使网页端只依赖持久队列、而不是本机 Chromium 服务。
5. 每新增一个节点，将主站的 `COURSE_VIDEO_EXPORT_PARALLELISM` 增加 1，用于队列等待时间估算。

节点使用数据库的 `FOR UPDATE SKIP LOCKED` 与五分钟租约。节点掉线后，租约过期的任务会被另一节点接管；课程版本发生变化时，旧视频任务仍会取消，绝不会覆盖新版本。

## 当前主站

当前主站的 `video-export-worker` 已经是这种独立 agent，只是和主站共用同一台机器，
因此维持单并发。增加服务器时无需改业务代码，只需把同一 agent 和 render service 部署到新节点。
