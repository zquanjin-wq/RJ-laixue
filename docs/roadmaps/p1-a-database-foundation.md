# P1-A：PostgreSQL 数据地基

> 状态：已完成  
> 日期：2026-09-01

## 本卡范围

P1-A 只建立正式数据库迁移入口和首批基础表，不接管现有 Supabase 业务流量。

已完成：

- 版本化 SQL migration 目录与受控执行命令。
- Better Auth 1.7.2 的 PostgreSQL 基础表。
- `app.user_profiles` 人员档案表，以及 `app`、`runtime` schema。
- 服务端共享 PostgreSQL Pool，默认最多 10 个连接。
- 真实空 PostgreSQL 初始化、再次执行跳过、认证用户关联业务档案验证。

## 使用方式

设置 `DATABASE_URL` 后执行：

```text
pnpm db:migrate
```

应用启动时不会自动执行 migration。部署时明确执行一次上述命令。

## 下一步

P1-B 已完成课程、课程资产、发布快照表和最小 repository 层。下一步进入 P1-C 学习任务数据地基；认证 API 和页面接管仍留在 P2。
