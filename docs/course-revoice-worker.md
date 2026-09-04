# 整课重新配音 Worker

整课重新配音使用 PostgreSQL 队列 `app.course_revoice_jobs`。生产 Docker Compose 会启动 `revoice-worker` 服务，每分钟请求一次应用内部的 `GET /api/cron/course-revoice`，每次领取并处理一个批次。

## 部署前置条件

1. 在 `.env.production` 配置随机的 `CRON_SECRET`。该值只由应用和 worker 容器使用，不能写入浏览器配置。
2. 配置 `TTS_MINIMAX_API_KEY` 以及腾讯云 COS 的 `TENCENT_COS_*` 变量。
3. 每次包含数据库迁移的版本上线前，先执行：

```sh
sudo docker compose --env-file .env.production build migrate
sudo docker compose --env-file .env.production --profile tools run --rm migrate
```

4. 构建并启动应用和 worker：

```sh
sudo docker compose --env-file .env.production up -d --build app revoice-worker
```

## 验证与排障

```sh
sudo docker compose --env-file .env.production ps
sudo docker compose --env-file .env.production logs --tail=100 revoice-worker
sudo docker compose --env-file .env.production logs --tail=200 app
```

`revoice-worker` 仅记录任务 ID、状态和失败消息，不输出 `CRON_SECRET`、TTS 密钥或 COS 密钥。若任务失败，前端轮询会显示 `message` 和 `error`，原课程音频保持不变。
