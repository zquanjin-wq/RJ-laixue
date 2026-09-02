# P1：大陆版 PostgreSQL 数据地基

> 状态：已完成  
> 日期：2026-09-01

P1 已建立可从空库初始化的大陆版数据地基：

- Better Auth 与人员档案。
- 课程、COS 资产记录和课程发布快照。
- 学习任务、课程包、任务名单和任务发布事务。
- 学习尝试、学习事件和任务/课程进度。
- 后台任务与模型用量记录。
- 普通 PostgreSQL RuntimeStore schema 和 node-postgres 执行适配器。
- 共享连接池、受控 migration 命令和关闭入口。

真实 PostgreSQL 验证覆盖空库初始化、重复 migration、课程版本冲突、任务发布、并发发布、学习事件幂等、后台任务领取、用量去重和 RuntimeStore 读写。

现有 Supabase 页面尚未切换，后续从 P2 的认证与人员管理垂直切片开始逐步接管。
