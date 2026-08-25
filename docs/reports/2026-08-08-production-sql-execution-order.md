# 生产 SQL 执行单：RuntimeStore v1

**日期**: 2026-08-08　**起草**: Kimi（Codex 角色）
**拍板依据**: R3 Production 决策卡 D2（`c2765030`）：仅授权单文件，执行前与 Preview 已验收版本逐字节一致
**状态**: ⏸️ 待负责人签字

---

## 1. 执行对象

| 项 | 值 |
|---|---|
| 文件 | `supabase-runtime-store-v1.sql`（432 行） |
| MD5 | `a6fb22a4e47a7a6c32048e01ca2c8623` |
| 最后变更 | `067c25d4`，2026-07-29 15:33 |
| Preview 执行 | 2026-07-30，Preview 项目 `ufwkylcsrppaamzqsvgx`，验收签字通过 |

**一致性论证**：文件最后变更时间（7-29 15:33）早于 Preview 执行时间（7-30），且 git 工作树零改动——生产即将执行的文件与 Preview 已验收版本**同源同字节**，D2 条件满足。

## 2. 目标环境

- **生产 Supabase 项目**（laixue.work 后端，与 Preview 隔离的另一个项目）
- 内容：3 张表（`runtime_sessions` / `runtime_records` / `runtime_merge_grants`）+ RLS 策略 + 14 个 `runtime_*` RPC + EXECUTE 收口
- **零业务表变更、零数据迁移**（新表，执行后均为 0 行）

## 3. 执行方式（二选一）

- **A（推荐）**：负责人在生产 Supabase 控制台 SQL Editor 粘贴执行——你亲手操作，我远程逐步核对
- **B**：授权我通过生产数据库连接串执行（需你提供连接串，走安全注入）

## 4. 执行后验收清单（我逐项核对）

1. 3 张表存在、均为 0 行、RLS 启用
2. learner 自身策略仅 `runtime_sessions_self` / `runtime_records_self` 两项，无教师策略
3. 14 个 RPC：service_role 14/14 可执行；anon 0/14；authenticated 0/14
4. 生产站点功能回归：登录、建课、保存、播放各一次人工冒烟
5. `NEXT_PUBLIC_RUNTIME_SHADOW` 仍**未设置**（本执行单不含开关授权）

## 5. 回滚

- 开关未开 → 表存在即无害，无需回滚
- 极端情况：`DROP TABLE runtime_records, runtime_sessions, runtime_merge_grants CASCADE` + 14 个 DROP FUNCTION（另出执行单，不在本单授权范围）

## 6. 红线

- 本单**仅**授权上述单文件执行
- 不含环境变量变更、不含业务表变更、不含 DROP 任何对象
- 执行窗口内若出现任何报错：停止、截图、不重试，先排查

---

**负责人签字**: ____________　**日期**: ________
