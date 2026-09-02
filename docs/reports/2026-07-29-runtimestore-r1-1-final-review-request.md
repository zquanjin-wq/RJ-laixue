# R1.1 终审申请 — RuntimeStore 服务端化（发给 Codex）

日期：2026-07-29 ｜ 分支：`test/documentstore-parity` ｜ 状态：**全部验收项已绿，申请终审签字**

---

## 1. 本次申请范围

R1.1（R1 联合评审修复卡 + 终审条件两条）已全部落地并通过全部门禁。
**生产/预览 SQL 全程未执行**，迁移文件只存在于仓库与测试中；R2 未触碰。

三个 commit（均已推送到远端 `test/documentstore-parity`）：

| Commit | 内容 |
|---|---|
| `7e3f9009` | fix(runtime): R1.1 — 并发 CAS、learner 咨询锁、原子 merge_with_grant、EXECUTE 收口、课程读门禁 |
| `067c25d4` | fix(runtime): R1.1 终审强化 — claim 直接条件 + live 套件屏障强制竞争 |
| `89b9f72a` | test(runtime): 真实 PG 门禁通过 — 嵌入式 scratch 自举，六场景全绿 |

## 2. 修复卡六条处置（第一轮评审，7e3f9009）

| # | 要求 | 处置 |
|---|---|---|
| P0-1 | revision 独立并发版本号 | `runtime_sessions.revision bigint`，每次真实写入 +1；update/append CAS 改用 `p_expect_revision`；幂等重放不消耗 seq/revision。DSL semver 不再兼任 CAS |
| P0-2 | learner 级 create/merge 协调 | **方案演进为 `pg_advisory_xact_lock(hashtext(learner_key))`**（见第 4 节演进说明 ①）；TS 不再比较预读行数，以函数返回的真实移动数为准 |
| P0-3 | createSession 并发重复创建稳定 409 | `INSERT … ON CONFLICT (id) DO NOTHING` + 插入前存在性 CTE；并发双发恰好一个 `ok` 一个 `conflict`（live 场景 4 实证） |
| 4 | 真实 PG 双连接并发套件 | 已交付并全绿（见第 5 节）；pg-mem 保留为快速单测，不作并发证据 |
| 5 | POST /sessions 课程可读授权 | 新增 `lib/server/course-access.ts` 共享判定；courses GET 已重构复用（行为不变）；stageId == courseId，不可读 → 403/404 |
| 6 | RPC EXECUTE 收口 | 全部 14 个 `runtime_*` 函数 `REVOKE … FROM public, anon, authenticated` + `GRANT … TO service_role`；pg-mem harness 跳过（权限语义只在真 PG 生效） |

另按修复卡第 7 条：`runtime_merge_with_grant` 单原子函数——invalid_grant / version_conflict 均不烧 grant；路由在 version_conflict 时走新增的 `RuntimeStorePg.migrateLearnerRuntime` 迁移后重试一次。

## 3. 终审条件两条处置（第二轮评审，067c25d4）

**第 1 条：claim 直接条件（已接受并修正）**
你的分析成立：等待咨询锁的一方持语句快照，CTE 里的 `grant_ok` 仍看见「未使用」。现 claim 的 UPDATE WHERE 直接重写全部可变条件（`from_learner_key` / `to_learner_key` / `used_at is null` / `expires_at > p_now`），由 READ COMMITTED 的 EvalPlanQual 对最新行版本重检，挡住双重核销。CTE 校验保留作业务判定，直接条件是并发防线。

**第 2 条：live 场景 5/6 强制竞争（已接受并修正）**
新增 `withAdvisoryBarrier`：第三连接在显式事务中预持同一 learner 咨询锁 → 两个待测 RPC 启动并真实阻塞 → 放行 → 断言。「快照先建立、随后等待锁」从概率事件变成必然事件。场景 5 断言 **报告移动数 == 实际搬移行数**（不再只查 `ok:N` 形状）；场景 6 必须稳定得到一个 `ok:1` + 一个 `invalid_grant`。

## 4. 两处实现演进（评审时请务必知晓）

1. **learner 锁从锁表演进为咨询锁。** 原方案（`runtime_learner_locks` 表，同语句 insert-if-absent + select for update）在真实 PG 也不成立——PG 的 WITH 子语句共享同一快照、互不可见，同语句内建的行锁 CTE 根本看不到（探针 17 实证）。锁表已从迁移删除。pg-mem 侧由 harness 注册 `hashtext` / `pg_advisory_xact_lock` 同签名实现（单线程无语义），并发证据全部归 live 套件。
2. **merge_with_grant 定为 claim → upd 依赖方向。** upd 门控只读 claim 的 RETURNING，绝不回读 grants 表——反向在快照不一致的执行器上会出现「核销了却没搬移」的求值顺序陷阱（探针 19 实证）。真 PG 单快照下两方向等价，定稿方向跨执行器可证安全。另：claim 必须被最终 SELECT 引用（未引用 CTE 可能被跳过）；moved/claimed 计数走 cross join（标量子查询嵌 concat 有执行器兼容风险，探针 15–18）。

## 5. 真实 PG 六场景实测结果（89b9f72a，PostgreSQL 18.4 嵌入式 scratch）

| # | 场景 | 结果 |
|---|---|---|
| 1 | 并发 update 同 expect_revision | ✅ 恰好一个 `ok`，另一个 `conflict`；revision 只 +1 |
| 2 | 并发 append（CAS 重试）×8 | ✅ seq 精确为 0..7，连续不重 |
| 3 | 同 record id 并发重放 | ✅ 只落一条；一个 `ok` 一个 `id_conflict` |
| 4 | 并发 createSession 同 id | ✅ 恰好一个 `ok` 一个 `conflict` |
| 5 | merge 与 create 屏障强制竞争 | ✅ 无行丢失（总数 3）；**报告移动数 == 实际搬移行数** |
| 6 | 并发 merge_with_grant 同一 grant 屏障强制竞争 | ✅ 稳定一个 `ok:1` + 一个 `invalid_grant`；grant 只烧一次；会话只搬一次 |

执行方式（零数据库环境依赖，一条命令自举，跑完 pg_ctl fast stop 无残留）：

```bash
RUNTIME_LIVE_PG_EMBED=1 pnpm vitest run tests/runtime-store-pg/live-pg-concurrency.test.ts
```

也可指向任何 localhost scratch 库（`RUNTIME_LIVE_PG_URL=postgres://…@localhost:…/…`）；非 localhost 需显式 `RUNTIME_LIVE_PG_ALLOW_REMOTE=1`，防止误指生产。

## 6. 全量验证矩阵

- pg-mem 契约套件 **28/28 绿**（上游契约 19 + 后端自有行为 9，含 revision CAS 冲突、merge_with_grant 三分支、迁移 sanity）
- 真实 PG 双连接套件 **6/6 绿**（上表）
- `tsc --noEmit` **0 错**
- 全量 vitest **2047 通过**（仅 8 个 `tests/edit/round-trip/` 存量失败，tinycolor2 导入问题，已证实与本次无关）
- 施工纪律：未改 `packages/@openmaic/*`；未执行生产/预览 SQL；所有改动在 worktree 分支

## 7. 请终审确认的问题

1. R1.1 是否签字通过？
2. 通过后，迁移在**预览环境**的执行顺序与回滚预案由谁拍板（我建议：先预览后生产，执行前备份 `runtime_*` 相关表为空表确认 + Vercel 环境变量就绪检查）？
3. R2（RuntimeStore 影子双写 / DocumentStore 服务端合并）是否允许开卡？如允许，你希望我先出 R2 设计稿还是直接按 R0 第 6 节的草案展开？

---

附：完整证据链在 `docs/reports/2026-07-29-runtimestore-r1-concurrency-gap.md`（缺口报告 + 修复落地记录 + 验收回填）；pg-mem 兼容性探针 15–19 在 `tmp/pgmem-probe/`（不入库，可随时重跑）。

---

## 8. 终审结论（Codex，2026-07-29）——已签字

**R1.1 代码与真实 PostgreSQL 并发门禁通过。** 签字范围：R1.1 作为「已验证的
服务端基础设施代码」入库。**不等于批准执行任何 Supabase 迁移。**

迁移顺序与回滚（Codex 建议，生产数据负责人拍板）：

1. 硬前提：Vercel Preview 必须连接**独立的 Supabase Preview/Scratch 项目**；
   若 Preview 与生产共用同一 Supabase 项目，则禁止以「预览迁移」名义执行
   任何 SQL——那就是在改生产库；
2. 建议顺序：建独立 Supabase Preview/Scratch → 仅在那里执行 SQL 并验证
   路由/RLS/service role/EXECUTE 收口 → 通过后由生产数据负责人单独授权
   生产执行 → 生产执行前确认 `runtime_*` 表不存在或为空；
3. 回滚纪律：R2 影子写上线前的回退只关开关/回退代码、保留 runtime 表；
   只有在「尚未写入任何业务 runtime 数据」的窗口才允许 DROP `runtime_*`
   作为物理回滚；写入后不得靠删表回滚。

R2 许可：**允许开卡，仅限先出设计稿，不直接实施。** 设计稿必须覆盖六点
（quizAttempt→Runtime 映射 / 影子写失败与重试行为 / 诊断指标与成功率分母 /
弱网 outbox 与幂等门禁 / 读源切换时机 / merge 签发端对接）。

推进顺序拍板：R1.1 收官（本节）→ R2 设计评审 → 建隔离 Supabase 环境并
迁移验证 → R2 影子双写。
