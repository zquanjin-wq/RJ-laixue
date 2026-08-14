# 课程重配音后台 Worker

整课重配音是服务端队列任务。生产环境必须由外部调度器每分钟请求一次：

`GET https://www.laixue.work/api/cron/course-revoice`

请求头必须为：

`Authorization: Bearer <CRON_SECRET>`

接口每次领取并处理一个工作批次，返回任务 ID、状态和进度；没有待处理任务时返回 `{"success":true,"job":null}`。接口失败返回 HTTP 500，便于调度器记录失败并告警。

## Vercel 套餐限制

Vercel Hobby 的 Cron 只能每天执行一次，不能承担此队列。请不要在 `vercel.json` 配置分钟级 Cron，否则部署会失败。Vercel Pro 可以配置分钟级 Cron；在未升级前，使用 EdgeOne CVM（或任意可信服务器）执行下列定时器。

## EdgeOne CVM：systemd timer

1. 将仓库中的 `scripts/run-course-revoice-worker.sh` 放到 CVM，例如 `/opt/laixue/run-course-revoice-worker.sh`，并赋予执行权限。
2. 创建仅 root 可读的 `/etc/laixue-revoice-worker.env`：

```ini
COURSE_REVOICE_URL=https://www.laixue.work/api/cron/course-revoice
CRON_SECRET=与 Vercel Production 环境变量完全相同的值
```

3. 创建 `/etc/systemd/system/laixue-revoice-worker.service`：

```ini
[Unit]
Description=Laixue course revoice worker

[Service]
Type=oneshot
EnvironmentFile=/etc/laixue-revoice-worker.env
ExecStart=/opt/laixue/run-course-revoice-worker.sh
```

4. 创建 `/etc/systemd/system/laixue-revoice-worker.timer`：

```ini
[Unit]
Description=Run Laixue course revoice worker every minute

[Timer]
OnCalendar=*-*-* *:*:00
Persistent=true
Unit=laixue-revoice-worker.service

[Install]
WantedBy=timers.target
```

5. 启用并验证：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now laixue-revoice-worker.timer
sudo systemctl start laixue-revoice-worker.service
sudo systemctl status laixue-revoice-worker.timer
sudo journalctl -u laixue-revoice-worker.service -n 50 --no-pager
```

同一时刻即使有多个触发请求，数据库领取锁也只允许一个实例处理同一任务。
