# M4 任务卡：上传链路与重负载拆分

**编号**: MIG-EO-M4  
**前置**: M3 任务模型签字  
**状态**: ⏸️ 待开工确认  
**预计**: 3–5 天  
**生产权限**: 仅非生产 Worker/Storage

## 1. 任务目标

确保 EdgeOne 请求不触碰 6 MB、120 秒和 128 MB 三条硬限制，将原生模块和长任务移动到可控的 Node Task Worker。

## 2. 路由分级

### A. EdgeOne 同步承载

登录鉴权、课程 CRUD、学习任务、学生/教师管理、短报表和健康检查。目标 p95 < 3 秒，单请求最坏 < 30 秒。

### B. EdgeOne 流式承载，实测后决定

`/api/chat`、短文本生成等主要等待上游模型且 CPU 较低的路由。必须验证 100 秒内完成或具备可恢复中断语义。

### C. Node Task Worker 承载

- 所有实际可能超过 100 秒的 300 秒路由。
- PDF/Office/图片转换和 `sharp` 原生依赖。
- 视频生成、批量 TTS、课程重新配音、课堂批量生成。
- 需要大包体、临时文件或大量内存的处理。

## 3. 实施清单

- [ ] `audio-upload` 改为服务端签名、客户端直传 Supabase Storage。
- [ ] 材料上传保留签名直传，服务端只接收对象 key 与元数据。
- [ ] Worker 提供受鉴权的任务 claim、heartbeat、complete、fail 接口。
- [ ] EdgeOne 到 Worker 使用短期签名或服务凭证，禁止公开内部执行端点。
- [ ] Worker 与 EdgeOne 传播统一 request/job ID。
- [ ] 对第三方模型、TTS、视频服务配置连接、读取和总任务超时。
- [ ] 对 49 MB 材料、50 MB 音频、25 MB 代理媒体执行边界测试。
- [ ] 从普通 Route Handler 移除 Worker 专属重依赖，复测包体。

## 4. 运行时门禁

- EdgeOne 动态请求体实测最大 ≤ 5 MB。
- EdgeOne 同步处理实测最大 ≤ 100 秒。
- 普通 Cloud Function 部署包目标 ≤ 100 MB。
- Worker 任务支持至少 15 分钟执行窗口，或可按步骤断点续跑。
- 上传失败不会留下可被公开访问的半成品；过期对象有清理策略。
- 客户端刷新、断网、重复点击后仍能恢复同一个任务。

## 5. 交付物

- Node Task Worker 非生产部署及运行手册。
- 上传改造代码与大文件边界测试。
- `M4-heavy-route-matrix.csv`：82 个路由最终归属。
- `M4-load-and-timeout-report.md`。

## 6. 边界与回滚

- ❌ 不部署生产 Worker，不切生产任务流量。
- ❌ 不将 Supabase Service Role 暴露到浏览器或 EdgeOne 公共变量。
- 通过 feature flag 将任务入口回退到 Vercel；已入队任务继续由原所有者处理完毕。

