# Gate 1A 学习任务数据模型、权限与 API 验收

> 验收日期：2026-08-11  
> 验收人：Codex  
> 结论：不通过，进入 Gate 1A.1 基础契约修订

## 1. 总体判断

路由、领域服务和基础单元测试框架已经形成，但当前实现尚不能安全进入 UI 开发。主要问题不是页面细节，而是数据库权限、事务、发布并发和快照语义没有满足 Gate 1A 契约。

## 2. P0 阻断项

### 2.1 SQL 迁移并非幂等

迁移使用多个裸 `create policy`。PostgreSQL 不支持 `create policy if not exists`，重复运行会因同名 policy 已存在而失败。必须在每个 policy 前 `drop policy if exists`，或使用等价幂等方案。

触发器幂等检查也应限定表 OID，不能只按全库 `tgname` 判断。

### 2.2 RLS 越权且违背“服务端 API 唯一写入口”

当前 authenticated 用户可直接：

- 读取所有 `course_snapshots`；
- teacher 读取所有任务；
- teacher 更新任意任务；
- teacher 读取、插入、更新所有 `task_learners`。

policy 名称写“own”，表达式却没有 `created_by = auth.uid()` 或 task owner 关联。Gate 1A 明确要求浏览器不直接写三张表，当前应撤销 anon/authenticated 表权限并不创建写 policy；服务端统一使用已鉴权 API + service role。

如果保留任何 authenticated select policy，也必须最小化到本人任务/本人 learner record，snapshot 不直接暴露。

### 2.3 不可变性只存在于注释

数据库没有阻止：

- update/delete `course_snapshots`；
- published/closed/archived 任务修改 `course_id/snapshot_id/created_by/task_type/source_task_id/share_token/published_at`；
- 非法状态迁移；
- 客户端通过直连写绕过 API 状态机（当前 RLS 又允许 teacher update）。

必须用触发器/受控 RPC 实施不可变性和状态机，不能只依赖 route。

### 2.4 发布不是原子或并发安全的

发布 route 使用“先查再写”。`.update(...).eq('status','draft')` 在零行命中时通常不会返回 error；并发失败方仍会返回自己生成但未落库的 token。并发创建相同 snapshot 时，唯一约束冲突也只会变成 500。

必须使用数据库 RPC/事务，以行锁或条件 update + `returning` 实现：

- snapshot upsert/冲突后复用；
- roster 非空校验；
- 唯一 token；
- 状态更新；
- 重复/并发调用返回同一数据库最终结果。

需要真实 PostgreSQL 并发测试，不接受忽略过滤条件的 Supabase mock 证明并发正确性。

### 2.5 创建和名单替换不是事务

创建 route 先插 task 再插 learners；第二步失败会留下半成品。名单 route 先 delete 再 insert，并在注释中称为“事务”，实际是两个独立 HTTP/PostgREST 请求；insert 失败会把名单清空。

必须使用 RPC/数据库事务，或实现经真实故障测试证明的数据一致性方案。

## 3. P1 必修项

### 3.1 快照不是可供历史任务使用的课程快照

当前 `snapshot_data` 只保存场景标题、顺序和 quiz 数量，不保存课程场景内容。课程后续修改后，旧任务无法从快照重放原内容，也无法验证必做题。应明确区分：

- 内部不可变完整快照：保存任务执行所需完整 `stage/scenes/outlines`；
- 对外安全视图：移除标准答案、内部字段和 warnings。

安全不是删除内部事实，而是禁止不可信客户端读取内部快照。

### 3.2 hash 未规范化

`JSON.stringify` 对对象键插入顺序敏感，不等于“规范化稳定 hash”。必须使用递归稳定排序/既有 canonical serializer，并测试语义相同、键顺序不同的数据得到相同 hash。

### 3.3 token入口先泄漏任务信息再鉴权

未到开始时间时，route 在检查 `task_learners` 之前直接返回任务 ID、标题和开始时间。任何登录用户只要获得 token 就可读取这些信息。必须先判定 learner assignment 或 admin/teacher preview，再返回 `not_started_yet`。

### 3.4 课程与补学来源校验不完整

- admin 创建任务时权限函数未确认课程存在，FK 错误会变成 500；
- remedial `sourceTaskId` 未校验存在、权限、任务类型和关联语义；
- PATCH 分别校验 start/due，但没有把 patch 与数据库旧值合并后检查最终时间范围，可能靠数据库 constraint 返回 500，而非稳定 400；
- published 名单禁止修改需要数据库/RPC层保障，不能只靠先查状态。

### 3.5 SQL约束不完整

至少补充：

- `completed_scene_count >= 0`；
- `total_scene_count >= 0`；
- completed count 不超过 total（语义允许时）；
- completion_rule 的版本和固定结构由服务端/RPC控制；
- normal/remedial 与 source_task_id 的一致性；
- share token 长度/非空约束；
- published后名单不可删除/新增（首版冻结名单）。

## 4. 测试可信度问题

当前 `MockSupabase` 的 `.eq/.in/.is` 基本不执行过滤，因此无法证明：

- teacher owner过滤有效；
- forged task/course/student ID 被拒绝；
- published条件更新实际命中；
- token查询只返回匹配行；
-名单校验正确。

13项API测试也未覆盖任务卡列出的多数情形，包括并发双发布、创建回滚、名单替换回滚、RLS、migration重跑、无owner课程、伪造受控字段、source task、完整状态机和时间边界。

Gate 1A.1必须增加：

- 真实 PostgreSQL migration测试（至少本地embedded PG）；
- migration连续运行两次；
- 真实约束/RLS/grant检查；
- 双连接并发发布；
- 故障注入证明创建和名单替换原子性；
- 过滤行为真实的API/领域测试。

## 5. 已认可部分

- API 路由边界和错误响应框架可保留；
- teacher/admin/learner 的应用层权限方向正确；
- token使用 `randomBytes(32).toString('base64url')` 满足随机性要求；
- 客户端受控字段没有直接写入基础 insert；
- 不进入 UI、未执行生产 SQL 的范围控制正确；
- 回滚说明方向正确，但回滚顺序中的 trigger drop 位于 table drop 后会引用不存在表，应修正或直接说明由 drop table 清理。

## 6. Gate 1A.1 退出条件

1. 迁移可重复执行且权限最小化；
2. 数据库实施快照/任务不可变性和状态机；
3. 创建、名单替换、发布均原子；
4. 并发发布返回同一最终 token/snapshot；
5. 内部完整快照与对外安全视图分离；
6. token入口先鉴权再返回任何任务状态；
7. 真实 PostgreSQL测试覆盖迁移、RLS、事务和并发；
8. TypeScript、格式与全量回归无新增失败；
9. 完成后停止，仍不进入 Gate 1B。

## 7. Gate 1A.1 首次复验新增发现（2026-08-11）

WorkBuddy 报告 42/43 测试通过，但复核确认所谓“迁移结构17项”仅正则匹配 SQL 文本，没有启动 PostgreSQL。Gate 1A.1 仍不通过，并新增以下阻断项：

1. 多个 `RAISE ... USING ERRCODE = 'INVALID_TIME_RANGE'` 等值不是 PostgreSQL 要求的5字符 SQLSTATE，RPC/trigger 无法按预期创建或执行；应使用合法自定义 SQLSTATE，并在 API 层映射业务错误码。
2. `publish_task` 的 snapshot 复用使用 `ON CONFLICT ... DO UPDATE`，但 `prevent_snapshot_modification` 禁止所有 UPDATE；复用已有 snapshot 会被自身触发器拦截。应 `DO NOTHING` 后查询最终 ID，或使用不触发不可变更新的原子 CTE。
3. 任务状态触发器没有约束 `draft` 的目标状态，数据库仍允许 `draft -> closed`。必须完整编码允许边集合，而不是只限制非 draft 来源。
4. `learning_tasks_normal_no_source` 实际表达式 `task_type = 'normal' or source_task_id is not null` 允许 normal 携带 source；应同时约束 normal/source null 与 remedial/source non-null。
5. `replace_task_learners` 只要至少一个 learner 有效，就会静默丢弃其他无效/disabled ID；必须像 create RPC 一样拒绝整个输入并保持旧名单。
6. RPC 内 hash 与 TypeScript canonical hash 不是同一算法：SQL 使用 `jsonb_strip_nulls(... )::text`，会删除 null；TS保留 null并递归排序。必须明确唯一规范并用跨层固定向量测试证明一致。
7. 当前没有真实 migration 重跑、RLS角色、trigger、RPC回滚、双连接并发测试；原任务卡的核心退出条件仍未满足。

下一轮不应继续扩充字符串正则测试。先让同一份迁移在 embedded/live PostgreSQL 中真实执行两次，再以 anon/authenticated/service_role或等价角色验证权限，并用两个连接验证发布锁与最终 token。
