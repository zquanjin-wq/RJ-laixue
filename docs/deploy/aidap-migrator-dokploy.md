# AIDAP 数据库迁移任务（Dokploy）

## 目的

使用独立的一次性任务验证当前 Supabase 与 AIDAP 的 PostgreSQL 连通性。它不修改 `laixue-web`、不读取网页终端输入，也不会在日志中输出密码。

## 任务服务

在 Dokploy 新建 **Application** 服务：`laixue-aidap-migrator`。

- Repository / branch：与现有 `laixue-web` 完全相同。
- Dockerfile：`Dockerfile.migration`。
- 不添加 Domain；不暴露端口；不启用自动部署。

在该服务的 **Environment** 中仅添加以下保密变量：

| 变量 | 值 |
| --- | --- |
| `MIGRATION_MODE` | `preflight` |
| `SOURCE_DB_PASSWORD` | 刚刚重置的原 Supabase **数据库密码** |
| `TARGET_DB_PASSWORD` | AIDAP PostgreSQL 密码 |

这两个密码由任务内部安全地编码为连接信息，不会在日志中输出。不要添加 `MIGRATION_CONFIRM`；`preflight` 没有写入能力。

部署后只看任务日志。成功标志是 JSON 中的 `"result": "preflight-ok"`。失败时任务会停止并显示缺少变量、网络或认证原因，但不显示密码。

## 当前边界

这个任务目前只完成了可重复的只读预检。正式复制必须先单独审核：业务表结构、Auth 用户哈希/身份记录、两个 Storage 桶的物理对象，以及 AIDAP 的 service-role API 能力；未完成审核前，禁止在目标执行导入或修改生产环境变量。
