# R1 并发缺口报告 + R1.1 修复方案（联合评审后）

> 日期：2026-07-29
> 状态：**修复方案执行中**
> 来源：Codex 只读联合评审（2026-07-29）。结论：R0 方向保留；R1 暂不通过；
> **不执行 `supabase-runtime-store-v1.sql`，不进 R2**。本文档逐条确认缺口、
> 给出修复方案，作为 R1.1 修复卡的执行依据。Kimi 对三条 P0 全部认可——
> 它们是真 bug，不是风格分歧。

## 1. P0-1：「CAS」不是 CAS（确认，根因在我）

**缺口**：`runtime_update_session` 用 `runtime_dsl_version` 做 `p_expect_version`。
但 DSL 版本（`'0.1.0'`）在普通状态更新/append 中不变：两个并发
`setSessionStatus` 都读到 0.1.0、都以 0.1.0 为条件写入 → 都成功 → 后写覆盖
前写，无 conflict。与「预读 + CAS + 重试」的承诺不符。

**修复**：
- `runtime_sessions` 新增 `revision bigint not null default 0`——**每次真实会话
  行写入都 +1**（status 更新、迁移写回、append 的 next_seq 递增都算）；
- `runtime_dsl_version` 回归本职：DSL 迁移 + 未来版本写保护，不再兼任并发版本号；
- `runtime_update_session` / `runtime_append_record` 的 CAS 条件改为
  `revision = p_expect_revision`；
- **幂等 record 重放不增加 revision 或 next_seq**（upd CTE 的 not-exists 守卫
  已保证，revision 挂在同一个 upd 上自然满足）。

## 2. P0-2：merge 与并发 create 竞态 → 「搬了数据却返回 0」（确认）

**缺口**：R1 的「预读行数 == 移动数」判定无法阻止预读后的并发 create 被
bulk update 一并搬走，重试第二轮返回 0，违反 mergeLearner「返回实际移动数」
的契约。

**修复**：learner 级协调锁 + 原子 merge：
- 新表 `runtime_learner_locks(learner_key text primary key)`；
- `createSession` 与 `mergeLearner` 都先在 CTE 里
  `insert … on conflict do nothing` + `select … for update` 拿同一把 learner 锁——
  同一 learner 的 create 与 merge 在数据库层串行化（不同 learner 互不阻塞）；
- merge 与 grant 核销合并为**单个原子函数 `runtime_merge_with_grant`**：
  grant 无效 → `invalid_grant`（不烧 grant、不动数据）；
  存在非期望版本行 → `version_conflict`（**不烧 grant**——回应评审第 51-52 行
  「claim 失败烧掉 grant」的体验问题，TS 迁移后再重试）；
  全部成功 → 核销 + 搬移 + 返回 `ok:<移动数>`；
- TS 不再比较「预读行数」，直接以函数返回的移动数为准（锁保证该数真实）。

## 3. P0-3：createSession 并发冲突绕过约定 outcome（确认）

**缺口**：`insert … where not exists` 在并发下以后来者主键唯一约束**异常**收场，
而不是约定的 `'conflict'`。

**修复**：改 `INSERT … ON CONFLICT (id) DO NOTHING RETURNING`，outcome 判定
顺序为「已存在 → conflict；插入成功 → ok；其余 → conflict」——真 PG 的并发
竞态与 pg-mem 的 returning 偏差都稳定映射为 conflict。

## 4. 「两次 RPC 替代单事务」的结论（接受前提，按此前提返工）

评审认可：单条 language sql CTE 在真 PG 原子；多 RPC 间不共享事务可以成立，
**前提是 CAS 用真正随写入递增的 revision**。R1.1 的第 1 条修复即此前提。
pg-mem 保留为快速单元测试（SQL 形状 + 行为），**不再作为并发语义的证据**。

## 5. 真实 PostgreSQL 双连接并发套件（新增，R1.1 验收硬门禁）

新增 `tests/runtime-store-pg/live-pg-concurrency.test.ts`：
- 用 `pg` 驱动开**两个独立连接**，env 门控（`RUNTIME_LIVE_PG_URL` 缺失时
  整套 skip——本地无库不影响 CI；执行生产/预览迁移前必须跑通一次）；
- 覆盖评审点名的六个场景：
  1. 并发 setSessionStatus：只有一个按旧 revision 成功，另一个拿到冲突；
  2. 并发 append：seq 连续不重复；
  3. 同 record id 并发重放：只落一条，双方拿到同一 record；
  4. 并发 create 同 session id：一方成功，一方稳定 409（不抛异常）；
  5. merge 与 create 同 learner 并发：移动计数正确，不漏、不重、不误报 0；
  6. grant 并发 claim：只有一个成功。

## 6. API 授权两处补齐（确认）

1. **POST /sessions 补课程可读授权**：现状只强制 learnerKey=auth.uid()，未校验
   stageId（= courseId）对当前用户可读。R1.1 复用课程路由的访问判定
   （ownership/assignment/share），抽成 `lib/server/course-access.ts` 共享助手；
2. **RPC EXECUTE 收口**：迁移末尾对每个 runtime_* 函数
   `revoke execute … from public, anon, authenticated` + `grant execute … to
   service_role`——「浏览器不直连」从约定变成数据库层事实。pg-mem harness
   跳过 revoke/grant 语句（与 RLS 段同待遇）。

## 7. 不做的事（防止修复卡膨胀）

- 不推翻 R0/R1 的任何拍板决策（merge token、留存、RLS 定位、learnerKey 强制）；
- 不改上游 `packages/@openmaic/*`；
- 不执行生产/预览 SQL——R1.1 评审通过前，迁移文件只存在于仓库和测试里；
- merge grant 的签发端（access-code 绑定流程）仍是 R3 范围。

## 8. R1.1 验收勾选单

- [ ] 缺口报告入库（本文档）
- [ ] revision CAS + learner 锁 + create ON CONFLICT + merge_with_grant + REVOKE
      全部进 `supabase-runtime-store-v1.sql`（文件内标注 v1.1 修订说明）
- [ ] pg-mem 契约套件 26/26 保持全绿 + 新增行为测试（revision 冲突、
      merge_with_grant 三分支、learner 锁存在性）
- [ ] 真实 PG 双连接套件六场景全绿（在有库环境执行并留记录）
- [ ] POST /sessions 课程可读授权接入 + REVOKE 进迁移
- [ ] tsc + 全量 vitest 双绿
- [ ] commit + push，发 R1.1 联合评审

## 9. R1.1 修复落地记录（2026-07-29，随修复 commit 入库）

全部六条已落地，过程中有两处实现层面的重要演进，评审时请注意：

1. **learner 锁从「锁表」演进为「咨询锁」**。原方案 runtime_learner_locks
   （insert-if-absent + select for update 同事务）在真实 PG 也不成立——
   PG 的 WITH 子语句共享同一快照、互不可见，同语句内建的行锁 CTE 根本
   看不到（探针 17 实证）。最终方案：
   `pg_advisory_xact_lock(hashtext(learner_key))`，createSession /
   mergeLearner / merge_with_grant 同锁串行。锁表已从迁移中删除。
2. **merge_with_grant 的 CTE 依赖方向定为 claim → upd**（核销先行、搬移
   门控只读 claim 的 RETURNING）。反向（upd 门控回读 grants 表）在快照
   不一致的执行器上会产生「核销了却没搬移」的求值顺序陷阱（探针 19
   实证）。真 PG 单快照下两种方向等价，但定稿方向跨执行器可证安全。

pg-mem 兼容处置（均为 harness 层，不影响生产语义）：注册 hashtext /
pg_advisory_xact_lock 同签名实现；moved/claimed 计数走 cross join 而非
标量子查询；最终分支不回读已被 claim 更新的 grants 表。探针 15–19
（tmp/pgmem-probe/，不入库）留有完整证据链。

验收结果：pg-mem 契约套件 28/28 绿（含新增 revision CAS、merge_with_grant
三分支）；tsc 0 错；全量 vitest 2047 通过（仅 8 个 tests/edit/round-trip/
存量失败，与本次无关）。真实 PG 双连接套件已交付
（tests/runtime-store-pg/live-pg-concurrency.test.ts，env 门控），
待有库环境执行后回填本行。
