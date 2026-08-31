# 课程视频后台导出 P0 + P1 实施记录

## 已完成

- 增加视频任务列表接口，返回当前老师自己的最近任务和下载地址。
- 增加后台收尾接口，复用项目已有 `CRON_SECRET`。
- 后台收尾会更新渲染帧进度、归档成功 MP4，并结束失败或取消任务。
- 超过 30 分钟仍未完成素材提交的任务会进入失败状态，不再永久显示“上传中”。
- 课程管理页增加“视频导出”区域，显示课程名、状态、进度、失败原因和下载入口。
- 我的课程卡片显示最新视频状态和下载按钮。
- 视频提交到渲染服务后，明确提示老师现在可以离开，并说明查看路径。
- 导出菜单在后台生成期间可以跳转到任务列表，不再只能显示禁用的旋转按钮。

## 部署前置

1. 在 Preview Supabase 执行 `supabase-course-video-export-jobs-background.sql`。
2. Preview 网页服务保留现有 `VIDEO_RENDER_SERVICE_URL`，并配置 `CRON_SECRET`。
3. 在 Dokploy 创建每分钟一次的 Schedule，请求：
   `https://video-preview.laixue.work/api/cron/course-video-exports`
   并携带 `Authorization: Bearer <CRON_SECRET>`。
4. 部署 Preview 网页服务后，完成一次“提交后关闭课堂页面”的验证。

## 验证结果

- 视频导出专项：8 项通过。
- ESLint：本轮文件 0 error、0 warning。
- TypeScript：本轮文件未出现新增错误；全仓仍有既有 OpenMAIC 子包依赖缺失错误。
- 本地正式构建受既有工作区环境阻断：PPTX vendor 未生成、pnpm 注册表校验失败，且当前 `node_modules` 符号链接不适用于 Turbopack。Dokploy 构建需作为最终构建门禁。

## 未包含

- 未实施“服务端直接读取云端课件源”；浏览器仍需先完成素材整理和上传。
- 未增加邮件、浏览器推送或复杂通知中心。
- 未改 Production、未执行 SQL、未修改任何线上环境变量。
