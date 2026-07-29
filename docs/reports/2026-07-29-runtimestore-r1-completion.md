# R1 完工报告：RuntimeStore 服务端 adapter + 契约测试全绿

> 日期：2026-07-29
> 状态：**完工，待评审**
> 依据：`2026-07-28-runtimestore-server-first-roadmap.md`（拍板）+
> `2026-07-28-runtimestore-server-r0-design.md`（已拍板设计，三点决策已同意）
> 验收标准（路线图 R1 行）：**契约测试对服务端实现全绿（复用上游
> `runtime-contract.ts` 测试套件）——已达成，26/26 全绿**。

## 1. 交付物清单

| 产出 | 路径 |
|---|---|
| 生产迁移 SQL（两表 + RLS + 14 个 rpc 函数 + merge grant 表） | `supabase-runtime-store-v1.sql` |
| RuntimeStore 接口的 Postgres 后端实现 | `lib/server/runtime-store/pg.ts` |
| 生产 rpc 适配器（PostgREST） | `lib/server/runtime-store/supabase-rpc.ts` |
| store 错误 → HTTP 映射 | `lib/server/runtime-store/http-error.ts` |
| routes 共享鉴权上下文 | `lib/server/runtime-store/request-context.ts` |
| browser/服务端共用 payload 校验映射 | `lib/runtime/payload-validators.ts` |
| RJ-contract-v1 routes ×5 | `app/api/runtime/v1/sessions/*`、`…/learners/merge` |
| pg-mem 契约测试 harness（加载同一份生产 SQL） | `tests/runtime-store-pg/pg-mem-harness.ts` |
| 契约套件 + 后端自有行为测试 | `tests/runtime-store-pg/runtime-pg-contract.test.ts` |
| 契约错误码扩充 | `lib/server/api-response.ts` |
| pg-mem devDependency | `package.json` / `pnpm-lock.yaml` |

## 2. 验收证据

- **上游契约套件 20 项**原样跑在 `RuntimeStorePg` 上（pg-mem 加载
  `supabase-runtime-store-v1.sql`）：全绿；
- 后端自有行为 6 项：迁移文件完整性、幂等重放（不消耗 seq）、
  IDEMPOTENCY_CONFLICT、merge grant 原子核销（一次性/过期/目标不匹配）、
  semver 盖戳、契约面 sanity：全绿；
- `tsc --noEmit`：全绿。

## 3. 实施中对 R0 设计的修正（评审时知悉）

1. **`learner_key` 用 text 不用 uuid**（R0 §1.1 原文为 uuid）。理由：契约套件
   fixture 用 `'anon:device-1'` 等非 uuid key；匿名 access-code 学员的 key 也不是
   uuid。`learnerKey = auth.uid()` 的强制在 API 层完成，列类型不背这个约束。
2. **版本列用 text 不用 integer**（R0 §1.1 未言明，实施时才发现）：
   `RUNTIME_DSL_VERSION = '0.1.0'` 是 semver 字符串。semver 顺序比较全部收在
   TS 层（`@openmaic/dsl` 的 `needsRuntimeMigration` / `runtimeDslVersionOf`），
   SQL 只做相等 CAS（`p_expect_version`）——同时避开 pg-mem 无 semver 函数与
   真 PG 写复杂比较表达式的双重麻烦。
3. **seq 分配用 sessions.next_seq 计数器**（R0 §2.1 原文为 `SELECT … FOR UPDATE`
   + `max(seq)+1`）。UPDATE 行锁天然串行化并发 append，且幂等重放不消耗 seq
   （重放时整个 upd CTE 为空）。等价且更快。
4. **全部函数用 `language sql` 不用 plpgsql**（R0 §2.1 伪 SQL 是 plpgsql 风格）。
   原因：PostgREST 无跨语句事务，多步逻辑必须在单语句 CTE 内完成；且 pg-mem
   不解释 plpgsql，契约测试无法跑同一份 SQL。language sql 函数 = 单语句 CTE，
   两个约束同时满足。
5. **幂等重放优先级**：已落库 record 的重放在会话 completed 之后仍幂等成功
   （R0 §2.3 未覆盖此排序）——outbox 延迟 flush 场景的必需品。
6. **merge grant 用一次性表行而非签名 token**（R0 §5 二选一中的表方案）。
   `runtime_claim_merge_grant` 单语句原子核销；grant 只能由服务端（未来的
   access-code 绑定流程）写入，RLS 无任何可见策略。

## 4. pg-mem 测试策略（探针 1–14 的结论）

契约测试的真实性来自「同一份 SQL 既上生产又进测试」。pg-mem 不支持的特性
及规避（全部实测，非猜测）：plpgsql（→ language sql）、多语句脚本（→ 逐条）、
`returns setof <table>`（→ `returns table(...)` 显式列）、UPDATE…FROM 的
RETURNING（→ 无 FROM 的 UPDATE + 相等 CAS）、绑定 null 参数（→ 哨兵值
'' / -1）、`to_jsonb`/混合类型 `jsonb_build_object`（→ 标量 outcome +
TS 取回行）、RLS/policy 语句（→ harness 跳过；授权在 API 层，契约不依赖）。
探针目录 `D:\WorkBuddy 地界\tmp\pgmem-probe\`（不入 git）。

## 5. 已知边界（不阻塞 R1，列入 R2/R3 跟踪）

- `runtime_merge_grants` 的**签发端**（access-code 绑定流程写 grant）尚未实现——
  那是绑定流程的地盘，R3 登录迁移阶段对接；当前 merge 路由无 grant 一律 403，
  行为正确且安全。
- append 的「预读父会话 + rpc」是两次 rpc 调用，高并发下同会话并发 append 由
  next_seq 行锁保证正确，但吞吐未实测——R2 影子期用遥测观察。
- 教师班级聚合视图（R0 §1.3 所述 service role + 授权）未做——R3 范围。
- R2 影子双写的 outbox（R0 §8 门禁：R3 前必须落地）未做——R2 范围。

## 6. R1 入口检查项（路线图 §9）逐条回应

1. **上游 HTTP contract 核查**：GFW 仍阻 GitHub 直连，未核查；RJ-contract-v1
   URL 版本号已兜底，网络恢复后补查（不阻塞）；
2. **复用上游契约套件**：✅ 本文档第 2 节；
3. **RJ 自有 kind 清单**：payload-validators.ts 当前注册 chat/quizAttempt 骨架
   守卫；`playback` 等 app-owned kind 按契约不校验（与 browser 默认一致）——
   R2 接入具体业务线时如需校验在此注册；
4. **api-guard learner 放行**：新增 `requireRuntimeUser()` 显式传
   `['learner','teacher','admin']`，未改动 api-guard 默认白名单，现有路由
   不受影响。

## 7. 下一步

R0 评审已过的前提下，R1 评审重点：第 3 节的 6 条设计修正。评审通过即进
**R2（quizAttempt 业务线影子双写）**：Dexie 读源不变 + RuntimeStore 服务端
影子写 + 失败静默回退 + 遥测计数（复用 b2.1/b2.2 的 diagnostics 模式）。
