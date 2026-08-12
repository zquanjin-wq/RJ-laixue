# Gate 1A 最终验收记录

- 验收日期：2026-08-11
- 验收人：Codex
- 结论：通过，可以进入 Gate 1B

## 最终修复

真实 PostgreSQL 契约测试发现状态机将“状态不变的普通更新”误判为非法状态迁移。迁移中的 `check_learning_tasks_immutability` 已改为仅在 `status` 实际变化时校验允许边；发布后的关键字段不可变检查继续独立生效。

同时确认以下基础修订已经落地：

- Live PG 使用独立角色连接并断言 `current_user`，匿名权限测试不再以管理员身份空跑。
- `pgcrypto` 安装在 `extensions` schema，`publish_task` 使用 schema-qualified `extensions.gen_random_bytes`。
- `anon`、`authenticated`、`service_role` 基础角色和测试登录角色分离。
- 三个受控 RPC 仅显式授权 `service_role`。
- 迁移完整执行两次，无语句拆分、过滤或错误吞没。

## 验证结果

- TypeScript `tsc --noEmit`：通过。
- 普通学习管理测试：73/73 通过。
- Live PostgreSQL 契约测试：12/12 通过，0 skipped。
- 相关 TypeScript/TSX 文件 Prettier：通过。

## Gate 结论

Gate 1A 数据模型、权限、原子 RPC、不可变约束、迁移幂等和并发发布契约满足当前阶段退出条件。未执行生产 SQL，未提交或推送代码。后续可以开始 Gate 1B 的教师任务管理界面和学员任务入口实现。
