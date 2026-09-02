# P5：北京服务器部署

> 状态：部署文件已准备，等待服务器接入  
> 日期：2026-09-02

部署组合：

- Caddy 提供 HTTPS 与反向代理。
- Next.js 应用只在 Docker 内网提供服务。
- PostgreSQL 不暴露公网端口，数据保存在命名卷。
- 数据库迁移使用受控的单次命令执行，不在应用启动时自动改表。

服务器准备好后：

1. 将 `deploy/.env.production.example` 复制为 `.env.production` 并填入实际值。
2. 执行 `docker compose --env-file .env.production --profile tools run --rm migrate` 初始化数据库。
3. 执行 `docker compose --env-file .env.production --profile tools run --rm bootstrap-admin <邮箱> <初始密码> "管理员姓名"` 创建首个管理员。
4. 执行 `docker compose --env-file .env.production up -d --build` 启动应用、数据库与 HTTPS。
