# Codex 交接文档 — RuntimeStore 主线进入 R3（截至 2026-08-02）

> 写给新开的 Codex/Kimi 任务：不依赖旧任务上下文。本文件是当前 RuntimeStore
> 主线的入口；引用的签字稿、实施报告和 E2E 报告是证据层。
>
> 当前一句话状态：**R1.1 服务端基础设施、R2 chat/quizAttempt 影子写、R2.1
> playback 本地恢复与影子写均已签字并在隔离 Preview 实测通过；下一步先调查
> chat 的 1 条 `idempotency_conflict`，再起草 R3 读源切换总设计稿。**

---

## 0. 新任务开场指令（先读、后做）

新任务第一轮只做两件事，顺序不可颠倒：

1. 建立并完成 **chat `idempotency_conflict` 调查卡**：定位同 record ID 内容漂移的
   字段、触发链路、复现条件、影响范围和处置建议。只调查，不改代码。
2. 调查结论形成报告后，以 R2/R2.1 已签字结果为输入，起草 **R3 总设计稿 v1**。

在 R3 设计稿获 Codex/负责人签字前：

- 不实施 R3 代码；
- 不执行任何生产 SQL；
- 不修改 Production 环境变量或部署；
- 不改变当前 Preview 两个影子开关；
- 不把服务端 RuntimeStore 改成课堂恢复读源。

## 1. 项目、分支与环境

- 仓库：`zquanjin-wq/RJ-laixue`
- 施工目录：`D:\WorkBuddy 地界\RJ-laixue-storage-b2`
- 施工分支：`test/documentstore-parity`
- 本交接生成时 HEAD：`1f8785c2`
- Production Supabase：`aqmktsagfvkikehynpdw`（禁止写入/执行 SQL）
- Preview Supabase：`ufwkylcsrppaamzqsvgx`（`rj-laixue-preview`）
- Preview 地址：
  `https://rj-laixue-git-test-documentstore-parity-rj-laixue.vercel.app`
- R2.1 E2E deployment：`dpl_3GKCce4pG3gj31XnzKi7dUmJdAcV`

当前开关：

| 环境 | `NEXT_PUBLIC_RUNTIME_SHADOW` | `NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK` |
|---|---:|---:|
| Preview | `1` | `1` |
| Production | 未设置 | 未设置 |

注意：`NEXT_PUBLIC_*` 是构建期内联。新增或修改后必须无缓存 Redeploy；Vercel
`Sensitive` 类型在构建期不可见，会让 Turbopack 把守卫折叠为 false并 DCE 掉代码。
这类变量必须使用 Preview-only 的普通 encrypted 类型。环境变量操作优先 API/CLI，
不要用控制台批量 upsert。

不要把账号密码、Supabase service role、Vercel token写进文档、提交或聊天。历史任务中
出现过短期 Vercel token；应视为已泄露/已过期，禁止复用。

## 2. 主任务是什么

主任务不是“把几条 shadow 请求打通”，而是：

> 让 RJ-laixue 的存储层对齐上游 `@openmaic/storage` 契约，在 Supabase/PostgreSQL
> + RLS 上实现可验证的 RuntimeStore/DocumentStore 服务端持久化，并保留未来
> 私有化替换后端的能力。

既定阶段：

| 阶段 | 目标 | 当前状态 |
|---|---|---|
| R0 | schema、RLS、CAS、身份与留存设计 | ✅ 完成 |
| R1/R1.1 | RuntimeStore API、RPC、真实 PG 并发正确性 | ✅ SIGNED |
| R2 | chat + quizAttempt 本地读源不变的影子写 | ✅ SIGNED，Preview 观察中 |
| R2.1 | playback 本地恢复、pending、影子写 | ✅ SIGNED，Preview E2E 通过 |
| R3 | 双读比对、读源切换、通用 outbox、登录迁移/灰度 | ⏳ 下一阶段，尚未设计签字 |
| R4 | 同一 HTTP contract 的私有化 Postgres 后端 | ⏳ 未开始 |

DocumentStore 线仍有 B2.3 主读写切流；它与 RuntimeStore 数据域独立，但共享服务端
adapter、版本线、RLS 和私有化方向。不能因为 RuntimeStore 进展顺利而默认 B2.3 已完成。

## 3. 主线复盘：我们是否偏离了目标

### 3.1 结论

**没有战略偏离。** 当前工作仍沿着“服务端基础设施 → 影子写 → 切读门禁 → 私有化”
推进，而且每个扩展均有明确签字和可回退边界。

### 3.2 看起来像支线、实际是必要门禁的工作

1. **隔离 Supabase Preview 与基础 schema 补齐**：不是业务扩张，是验证 RuntimeStore
   routes/RLS/service-role 的硬前提，避免 Preview 误写生产。
2. **R2.1 playback**：最初从 R2 移出，是因为本地 playback 持久化链路本身休眠，
   直接影子化会再次使用内存状态。A1 先接通本地恢复，A2 再做 pending/影子写，
   这是 R3 离线、刷新、跨标签页语义的前置验证。
3. **Vercel 构建期变量排障**：属于受控开启验证，不是产品功能开发；结果沉淀为
   双开关与无缓存部署门禁。

### 3.3 实际发生的范围扩展

- 原路线 R2 建议只选一个低风险业务线；最终 R2 覆盖 chat + quizAttempt，R2.1 又纳入
  playback。该扩展是负责人/Codex 分阶段批准的，并始终保持本地读源不变。
- 扩展带来了价值：R3 设计现在有三种真实负载（高频 chat、周期 quiz、快照 playback）
  的证据；代价是观察面更复杂，因此 R3 前必须先关闭 chat 内容漂移疑点。

### 3.4 仍需防止的偏离

- 不要直接开始写 R3 代码；当前缺的是设计与门禁，不是更多实现。
- 不要把 playback 的“单 stage 单行 pending”原样泛化成通用 outbox；它只是参照实现。
- 不要用服务端 shadow records 做正式课堂恢复，R2 数据字段经过裁剪且尚非读源契约。
- 不要把 chat 409 当作“已签字所以忽略”；它可能暴露 record 内容不确定性，必须先调查。
- 不要把 RuntimeStore 完成误写成整个存储主线完成；R4 和 DocumentStore B2.3 都未完成。

## 4. 已完成的签字链

### 4.1 R1.1 服务端基础设施

- 关键修复：`7e3f900`
- 签字记录：`52862d2e`
- 真实 PostgreSQL 18.4 并发门禁：6/6
- runtime_* RPC：service_role 14/14；anon/authenticated 0/14
- learner RLS，无教师直通策略
- Preview 已执行 runtime schema；Production 未执行

### 4.2 R2 chat + quizAttempt

- 设计：`692cf9b7`
- 实施与验收修订：`5e6c1366`、`cbfd3b91`、`57a10a18`、`30c71f01`
- 签字：`313f8941`，报告：
  `docs/reports/2026-07-30-runtimestore-r2-signed.md`
- Preview E2E：chat 与 quizAttempt 均通过；观察期开始于 `9dfd2454`

不可重开的 R2 决策：

- chat payload 只含 `{role, content}`；R3 前不得作为正式读源/审计记录；
- quizAttempt 使用单键 envelope `{v, attemptId, answers}`；
- 影子路径的身份/答案必须从持久化状态读回；
- 匿名期不影子写；access code 不能作为分区键；
- 409 `idempotency_conflict` 不重试，但必须遥测。

### 4.3 R2.1 playback A1

- 设计演进：`aef26a17` → `cc96b0db` → `ad1997d9` → `5cef673d`
- 实施：`7836aa44`
- 复审修复：`f3223568`
- A1 SIGNED：44/44

已验证：5 秒 trailing/latest 节流、pause/stop/scene/visibility/pagehide flush、串行
Dexie 写、sceneId 恢复、引擎 cursor 恢复、不自动播放、completed 本地语义。

### 4.4 R2.1 playback A2

- 主体：`f2b532e1`
- 第一轮修复：`30f66c35`
- 第二轮修复：`3faccb3a`
- 签字：`70438526`
- 签字报告：`docs/reports/2026-08-02-runtimestore-r2.1-a2-signed.md`
- Preview E2E：`1f8785c2`
- E2E 报告：
  `docs/reports/2026-08-02-runtimestore-r2.1-playback-preview-e2e.md`

最终门禁：88/88。关键不变量：

- 每次业务落盘生成 UUID，快照/eventId/structured pending 同一次 Dexie put；
- shadow 只从 Dexie 读回，不使用调用方内存数据；
- pending 清除在 Dexie rw 事务内按 eventId 条件执行；
- legacy 升级事务 CAS，四态幂等状态机；
- completed 的 append + status 成功后才删除本地行，PATCH 失败保留补偿；
- superseded 是 `source: local_drop` 本地指标，不混入请求成功率；
- 最新快照按 `capturedAt`，同时间按 eventId 字典序 tie-break；
- playback 需要总开关与独立子开关同时为 `1`。

Preview 实测：两条 `pb:u_sj94ssIi:*` records 均 201；跨 scene；payload v1/capturedAt
正确；pending 清除；遥测 `ok/append_record/playback` 落地。

## 5. 当前唯一必须先查的风险：chat idempotency conflict

R2.1 Preview E2E 同期观察到 1 条：

```text
runtime_shadow {
  outcome: "idempotency_conflict",
  op: "append_record",
  kind: "chat"
}
```

网络层对应 chat records 409：同一 record ID、内容不同。R2 的“不重试并遥测”行为正确，
但内容漂移原因未知。它不推翻 R2/R2.1 签字，却可能阻断 R3 chat 切读。

调查卡必须回答：

1. record ID 从哪一层生成，是否稳定绑定原始消息；
2. 两次请求的 `role`、`content`、`createdAt`、`sceneId` 哪个字段不同；
3. 是否由流式消息从 partial 变 final、消息对象原地更新、截断游标归零、刷新重放、
   跨标签页或 createdAt fallback 漂移导致；
4. 是否可以在单测稳定复现；发生频率和影响范围；
5. 最小处置是“延迟到消息稳定后写”“record ID 纳入 revision”“冻结首写内容”还是其他；
6. 对 R3 的结论：仅 chat 阻断，还是通用幂等/outbox 设计也需调整。

调查边界：只读 Preview 日志/记录与本地代码；不得读取生产业务数据，不得直接修代码。
产出建议：`docs/reports/2026-08-XX-runtime-chat-idempotency-conflict.md`。

## 6. R3 总设计稿必须回答的问题

建议文件：`docs/reports/2026-08-XX-runtimestore-r3-read-cutover-design.md`。

最低章节：

1. **按 kind 切读门禁**：chat、quizAttempt、playback 分别定义完整性、排序、恢复语义；
2. **阶段状态机**：local-only → shadow → dual-read compare → server-preferred →
   server-primary；每一步进入/退出条件；
3. **通用 outbox**：是否建新表、队列记录形状、幂等 ID、重试/退避、死信、压缩；
   明确 playback 单行 pending 只作为输入，不是默认答案；
4. **离线/刷新/跨标签页**：锁/CAS/lease、旧请求晚成功、旧客户端并存；
5. **顺序与冲突**：server seq、capturedAt、eventId tie-break、409 处置；
6. **读失败降级**：服务端不可达、超时、部分记录、版本不兼容时如何回落本地；
7. **登录迁移**：匿名数据是否进入服务端；merge-grant 签发端；不透明 `ac:<uuid>`；
8. **消息完整语义**：R2 chat 字段裁剪不够作为正式读源，R3 必须重新评审；
9. **灰度控制面与 SLO**：样本量、match 率、missing/mismatch、409、pending age、
   superseded、回切阈值；
10. **数据生命周期**：24 个月归档、删除、隐私和教师聚合路径；
11. **Preview/Production 发布**：环境隔离、无缓存构建验证、单独生产授权；
12. **回滚**：关读开关/回退代码但保留表；写入业务数据后不得 DROP 回滚；
13. **R4 接口边界**：不能让 R3 客户端绑定 Supabase 专有实现，继续走 HTTP contract。

R3 v1 只写设计与验收矩阵，不写实现。

## 7. 当前控制面与红线

1. Production 项目 `aqmktsagfvkikehynpdw`：禁止写入、SQL、开关和部署，除非负责人
   针对具体动作单独授权。
2. Preview 当前两个 shadow 开关保持开启观察；异常时允许的默认回退是关 Preview
   开关/回退代码，保留 runtime 表和观测数据。
3. 写入任何业务 runtime 数据后，不允许用 DROP runtime_* 表作为回滚。
4. 不建教师 RLS 口子；教师聚合走 service role + api-guard。
5. 不修改 `packages/@openmaic/*`，除非证明上游缺陷并另获批准。
6. 不迁移生产业务数据；不把测试账号凭据写入报告。

## 8. 关键代码和报告索引

| 主题 | 路径 |
|---|---|
| Runtime shadow 核心 | `lib/runtime/shadow-writer.ts` |
| playback 持久化/pending | `lib/utils/playback-persistence.ts` |
| playback flush 接线 | `lib/utils/playback-flush-wiring.ts` |
| playback UI 接线 | `components/edit/PlaybackChromeRoot.tsx` |
| chat 本地保存/影子挂点 | `lib/utils/chat-storage.ts` |
| quiz envelope | `lib/quiz/persistence.ts` |
| 遥测入口 | `app/api/client-diagnostics/route.ts` |
| Runtime routes | `app/api/runtime/v1/sessions/**` |
| 服务端 adapter | `lib/server/runtime-store/*` |
| payload validators | `lib/runtime/payload-validators.ts` |
| playback A2 tests | `tests/playback/playback-shadow-a2.test.ts` |
| R2 tests | `tests/runtime-shadow/` |
| 真实 PG 并发 | `tests/runtime-store-pg/live-pg-concurrency.test.ts` |
| 旧总交接 | `docs/reports/2026-07-30-codex-handoff-runtime-line.md` |
| R2 签字 | `docs/reports/2026-07-30-runtimestore-r2-signed.md` |
| R2.1 设计 | `docs/reports/2026-07-31-runtimestore-r2.1-playback-design.md` |
| R2.1 A2 签字 | `docs/reports/2026-08-02-runtimestore-r2.1-a2-signed.md` |
| R2.1 Preview E2E | `docs/reports/2026-08-02-runtimestore-r2.1-playback-preview-e2e.md` |
| 生成误分类遗留 bug | `docs/reports/2026-07-28-agent-text-action-leak.md` |

## 9. 验证命令与当前测试基线

优先使用仓库现有可执行文件，避免 pnpm 签名/联网切版：

```powershell
& '.\node_modules\.bin\vitest.cmd' run tests/playback tests/lib/playback `
  tests/edit/stage-mode tests/edit/regen-lock tests/audio/audio-player-leak `
  tests/runtime-shadow --no-file-parallelism

& '.\node_modules\.bin\tsc.cmd' --noEmit --pretty false
```

截至 A2 终验：相关测试 88/88。`tsc --noEmit` 仅有 4 个已知环境错误：

- `tests/runtime-store-pg/live-pg-concurrency.test.ts` 找不到 `pg`，并衍生 2 个 implicit any；
- `tests/runtime-store-pg/pg-mem-harness.ts` 找不到 `pg-mem`。

不要把这 4 项误归因于 R2.1；也不要绕过包管理器安全校验下载未知二进制。

## 10. 任务追踪表

| 项目 | 状态 | 下一检查点 |
|---|---|---|
| R2 chat/quiz Preview 观察 | 进行中 | 统计 ok/409/失败及样本量 |
| R2.1 playback Preview 观察 | 进行中 | pending/superseded/失败率、completed 补偿 |
| chat idempotency conflict | **立即下一项** | 调查报告 + 可复现性 + R3 影响结论 |
| R3 总设计稿 | 等待 chat 调查 | v1 评审，不写代码 |
| Production runtime SQL/开关 | 未授权 | 负责人单独书面授权 |
| R4 私有化 Postgres | 未开始 | R3 接口边界稳定后立项 |
| DocumentStore B2.3 | 未完成 | 不与 RuntimeStore 完工混淆 |
| agent text/action 误分类 | 遗留 | 生成管线另案，不阻塞当前调查但需继续追踪 |

## 11. 给新任务的可复制请求

```text
请先完整阅读 docs/reports/2026-08-02-codex-handoff-runtime-r3.md，
它是 RuntimeStore 主线当前交接文档。第一项任务不是改代码：建立并完成
chat idempotency_conflict 调查卡，定位同 record ID 内容漂移字段、触发链路、
复现条件、影响范围和处置建议，产出调查报告。调查结论通过评审后，再以
R2/R2.1 签字材料为输入起草 R3 读源切换总设计稿 v1。未获批准前不实施
R3 代码、不执行 SQL、不修改 Preview/Production 开关。
```

