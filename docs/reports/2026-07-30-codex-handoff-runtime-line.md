# Codex 交接文档 — RuntimeStore 服务端持久化主线（截至 2026-07-30）

> 写给新开的 Codex 会话：你不需要任何历史上下文，本文件 + 引用文档即全部真相。
> 主线目标：RJ-laixue（OpenMAIC v0.3.1 fork）存储层对齐上游方向——
> RuntimeStore/DocumentStore 服务端持久化（Supabase/PostgreSQL + RLS，私有化可替换后端）。

---

## 0. 项目与施工环境

- 仓库：`zquanjin-wq/RJ-laixue`（上游 `THU-MAIC/OpenMAIC` v0.3.1，MIT）
- **施工目录（永远用这个 worktree，不碰主 worktree）**：`D:\WorkBuddy 地界\RJ-laixue-storage-b2`
- **施工分支**：`test/documentstore-parity`，当前 HEAD = `4244e4ae`
- 主 worktree `D:\WorkBuddy 地界\RJ-laixue` 的 main = `4324ca9`（v0.3.1 元素级编辑已合入，勿动）
- 生产：https://www.laixue.work（Vercel 自动部署 main）；本地 `pnpm dev --webpack`
- LLM：全部流量走 MiniMax Anthropic 兼容端点（业务决策：老师/学员不自配 LLM）
- 禁区：**不改 `packages/@openmaic/*`**（除非先证明上游缺陷并获批）；不执行任何 Supabase SQL（见 §4 迁移前置条件）

**工具链命令（Windows，审批常过期，过期重试 ≤2 次后停下汇报）：**
```bash
cd "/d/WorkBuddy 地界/RJ-laixue-storage-b2"
"/c/Users/ruijie/AppData/Roaming/npm/pnpm.cmd" install --ignore-scripts   # install 必须加 --ignore-scripts
"/c/Users/ruijie/AppData/Roaming/npm/pnpm.cmd" vitest run --no-file-parallelism [路径]
NODE_OPTIONS="" node node_modules/typescript/bin/tsc --noEmit; echo "TSC_EXIT=$?"
# 真实 PG 并发门禁（自举 embedded-postgres，二进制复制到 %TEMP% 跑）：
RUNTIME_LIVE_PG_EMBED=1 "/c/Users/ruijie/AppData/Roaming/npm/pnpm.cmd" vitest run tests/runtime-store-pg/live-pg-concurrency.test.ts
```
- 存量基线：8 个 `tests/edit/round-trip/` 导入解析失败（pptxgenjs/tinycolor2），非任何一方引入，验收时容忍
- GitHub 直连常断（GFW/办公网），push 失败是常态；失败重试 2 次后请用户在 GitHub Desktop 推
- 办公区网络阻断（GFW 交接文档遗留问题）至今无短期/长期方案，是环境约束不是代码问题
- commit message：英文 subject + 详细 body；报告入库 `docs/reports/`；每个逻辑步骤独立 commit

## 0.5 架构路线决策：接口用上游，后端用 Supabase（2026-07-30 负责人确认）

**上游 v0.3.1 的存储架构 = 两样东西**：`@openmaic/storage` 的抽象接口（RuntimeStore/DocumentStore）+ 上游自己的 Postgres 服务端实现与一键部署脚本。本 fork 的路线是**采用前者、不原样采用后者**。

**为什么不原样搬上游的后端实现**——它绑在上游自己的部署模型上，而我们的地基全长在 Supabase：

| 维度 | 上游做法 | 本 fork 现状 | 直接搬的后果 |
|---|---|---|---|
| 认证 | 上游自己的账号体系 | Supabase Auth，`auth.uid()` 即 learnerKey | 学员/老师账号体系推倒重来 |
| 数据权限 | 上游服务端代码控制 | Supabase RLS（数据库层强制） | 权限模型重写，失去 RLS 兜底 |
| 已有数据 | — | 课程、课程发布、TTS 语音、access-code 绑定全在 Supabase | 线上数据迁移，save-to-cloud 链路重写 |
| 部署 | 一键 Docker 自托管 Postgres | Vercel Serverless + Supabase 托管 | 多一套需运维的数据库服务 |

**结论**：Postgres 路线并未偏离（Supabase 底层就是 PostgreSQL，我们用的是托管版 + RLS）；抽象层完全对齐（客户端面对上游同款接口，未来 rebase 不冲突）；不采用的只是上游的自托管后端实现。R1.1 的 `runtime_*` 表 + RPC + RLS 就是这个决策的产物——上游接口、Supabase 后端。

## 1. 分工（培训部门负责人拍板）

- **Codex（你）**：上游 v0.3.1 对齐主线的工程执行负责人——B2 本地 DocumentStore 迁移验证、RuntimeStore/DocumentStore 服务端 adapter、Supabase/私有化后端接入、测试、CI、报告、独立 commit
- **Kimi K3**：edit_elements 元素级 AI 编辑（已收官合入 main）；后接手 B2.2 验证修复 + R0→R1→R1.1→R2 的 RuntimeStore 服务端线
- **WorkBuddy**：资产侧改动（大文件上传 `3d80b985`/`31c48b3e` 等）
- 最终业务决策与优先级：培训部门负责人

## 2. 已完成里程碑（按时间序，含全部关键 commit）

### B2.1/B2.2 本地 DocumentStore 影子复制与双读比对 ✅ 已收官
- B2.1 影子复制、B2.2 双读比对代码由 Codex 完成（`b697f853` 基础 harness 等）
- Kimi 修复两个阻断问题：
  - Preview `TypeError: (void 0) is not a constructor` → `ac3ab6bd` fix(storage): resolve @openmaic/storage runtime away from .d.ts paths entry
  - 真实课程 `txo6PVFVnx` 双读 `errorCode:"validation"` → **方案 A**（RJ 扩展 validator 放行 widened scene kind），`87150783`；interactive/pbl 校验缺口同案解决（A/B/C 对比结论：选 A，对上游 rebase 影响最小）
- 课程 `1I_kD25GX1` 的 validation 失败根因 = **生成链路误分类 bug**（agent text/action 泄漏进课件 DSL），报告：`docs/reports/2026-07-28-agent-text-action-leak.md`。**该 bug 修复归 Codex/WorkBuddy 生成管线，至今未修**；涉事课程已被用户删除，无需数据修复
- 验收：Vercel 遥测 `document_bridge outcome:"success"` + `document_parity outcome:"match"`（7 条 parity 日志，match/missing_document 均为预期），用户实测通过
- 开关：`NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE` / `NEXT_PUBLIC_DOCUMENT_STORE_PARITY_CHECK`（默认关，.env.example 有注释）

### R0 方案拍板 ✅
- 结论：RuntimeStore 服务端化**提前**（不等 DocumentStore 全量切完）
- 三项拍板（负责人口头同意，已记录）：
  1. `mergeLearner` 授权：merge 必须携带 access-code 绑定流程签发的**短期 merge token**，客户端自报 fromLearnerKey 一律 403
  2. 留存策略：archived 会话保留 24 个月后导出对象存储再物理清理（~1GB/学期，无需分区表）
  3. RLS 不开教师口子

### R1 → R1.1 服务端 RuntimeStore 基础设施 ✅ 已签字收官
- R1 先交并发缺口报告、不执行生产 SQL；Codex 联合评审「条件通过」，指出：merge_with_grant claim CTE 在真实 PG 下的 EvalPlanQual 竞态（快照先于咨询锁建立）、场景 5/6 测试偏概率性、createSession 需 ON CONFLICT DO NOTHING、课程可读授权缺口、RPC EXECUTE 未收口
- R1.1 修复：`7e3f900` fix(runtime) + `52862d2e` docs: R1.1 SIGNED
  - claim 的 UPDATE WHERE 内直接重复 `from/to/used_at is null/expires_at`（并发正确性最后防线）
  - 场景 5/6 改第三连接预持 `pg_advisory_xact_lock(hashtext(learnerKey))` 的强制竞争；场景 5 断言 mergeOutcome 数字与实际移动数相符；场景 6 稳定得到 ok:1 + invalid_grant
  - 独立 revision 脱离 runtime_dsl_version；create/merge 共用 learner 咨询锁；POST /sessions 复用课程可读判断；`REVOKE ... FROM public, anon, authenticated` + `GRANT ... TO service_role`
- **真实 PostgreSQL 18.4 六场景并发套件 6/6 绿**（pg-mem 仅作快速单测，不替代真实 PG）
- **签字原文（52862d2e）**：R1.1 可作为「已验证的服务端基础设施代码」入库；**不等于批准执行任何 Supabase 迁移**

### R2 影子双写 ✅ 已签字收官（2026-07-30 SIGNED）
- 设计稿 v2.1：`692cf9b7` + 勘误（Codex 终审 4 项拍板 + 2 个 P0 已落实，见 §3）
- 实施：`5e6c1366`（初版）→ `cbfd3b91`（验收卡修订：quiz 单键 envelope 原子写、
  playback 移出 R2）→ `57a10a18`/`30c71f01`（文档勘误）
- 签字记录：`docs/reports/2026-07-30-runtimestore-r2-signed.md`——
  **范围限定 chat + quizAttempt；playback 另立 R2.1 前置卡；签字不授权生产 SQL**
- 门禁：专项 69/69（Codex 独立重跑确认）；tsc 0 error；全量 2077 passed（仅 8 个存量失败）

## 3. R2 终审裁决（不可重开，已实施）

1. **字段裁剪**：chat 只带 `{role, content}`（不带 title/config/toolCalls/pendingToolCalls）；仅限 R2 影子期——影子数据不得作为未来读源或审计依据，R3 切读前另行评审完整消息语义
2. **`ac:<code>` 被拒绝**：access code 是凭证，不得作数据库分区键/grant 响应字段/日志内容；R2 不覆盖匿名写故该约定已删除；未来匿名服务端写用服务端签发的随机不透明 ID（如 `ac:<uuid>`）
3. **匿名期不影子写**：R2 只覆盖 auth.uid() 已登录用户；匿名服务端授权与迁移合并另立任务
4. **开关用环境变量** `NEXT_PUBLIC_RUNTIME_SHADOW`（默认关），不建站点配置表；灰度控制面是 R3 的事
5. **P0-1 playback**：`pb:<stageId>:<monotonic-n>` 不可靠（刷新/跨标签页复用）——每次保存先生成新 UUID `runtimeShadowEventId` 随快照**同一次 Dexie put** 持久化，record id = `pb:<stageId>:<eventId>`，重试只能复用持久化 id
6. **P0-2 quiz**：attemptId = UUID，持久化在 localStorage `quizAttemptId:<sceneId>`，与 answers 同一次写入；`clearSubmitted` 后才允许生成新值；会话 id = `qa:<stageId>:<sceneId>:<attemptId>`
7. **merge-grant 签发不入 R2**（无可合并的匿名服务端数据，保留为后续匿名 RuntimeStore 的设计前提）

## 4. 迁移前置条件（Codex 终审拍板）

**当前状态（2026-07-31 更新）：硬前提已满足，Preview 项目迁移已执行，Preview 环境变量
值已修正并复验通过，测试账号就绪；生产项目未触碰。**

1. ~~硬前提：Vercel Preview 必须连接独立的 Supabase Preview/Scratch 项目~~ **已满足**：
   Vercel 三条 Supabase 变量（URL/ANON/SERVICE_ROLE）已按环境拆分——Production → 原项目
   `aqmktsagfvkikehynpdw`（线上 bundle 实测验证），Preview → 新独立项目
   `rj-laixue-preview`（ref `ufwkylcsrppaamzqsvgx`）。
   **经验教训（两条）：**
   1. Vercel 控制台多行新增表单对同名键是 upsert 语义（曾覆盖生产条目约 24
      分钟，已用 API 恢复）；后续环境变量操作一律走 API/CLI，不用控制台。
   2. NEXT_PUBLIC_* 变量在构建期内联进 bundle；改环境变量后必须 **Redeploy 时
      取消勾选 "Use existing Build Cache"**（2026-07-31 两次踩坑：push 触发的构建与
      普通 Redeploy 都复用了带旧值的 .next 缓存）。更严重的是 upsert 事故残留的
      Preview 变量**值**本身是错的（指向生产项目），2026-07-31 已通过 API PATCH
      修正三条 Preview 值（临时令牌 env-fix-tmp 用完即删），无缓存重部署后
      Preview bundle 实测指向 `ufwkylcsrppaamzqsvgx` ✅（chunk 内嵌地址验证）。
2. 顺序：~~建独立 Supabase Preview/Scratch~~ ✅ → ~~仅在那里执行 SQL 并验证~~
   **Preview 迁移已执行（Codex，2026-07-30）**：`supabase-runtime-store-v1.sql` 成功；
   `runtime_sessions`/`runtime_records`/`runtime_merge_grants` 已建、为空、启用 RLS；
   仅 learner 自身策略（`runtime_sessions_self`/`runtime_records_self`），无教师策略；
   14 个 runtime_* RPC：service_role 14/14 可执行，anon 0/14，authenticated 0/14。
   **已完成（2026-07-31，Kimi/WebBridge）**：Auth redirect URL 已加 `https://*.vercel.app`；
   Preview 部署地址 `https://rj-laixue-git-test-documentstore-parity-rj-laixue.vercel.app`
   （构建 CgveErY7，bundle 已验证指向 Preview 项目）；测试账号已在 Preview 项目注册
   （email+password，Auto confirm，凭据由负责人保管转发）。
   **待完成**：验证登录态下
   create/append/status 路由、RLS 与 service-role 调用链 → 通过后由负责人**单独授权**生产执行
   → 生产执行前确认 runtime_* 表不存在或为空
3. 回滚语义：R2 影子写上线后如需回退，只关开关/回退代码，保留 runtime 表；**只有在「尚未写入任何业务 runtime 数据」的窗口才允许 DROP runtime_* 物理回滚**，写入后不得靠删表回滚
4. **`NEXT_PUBLIC_RUNTIME_SHADOW` 保持关闭**：应用路由验证未完成前不得开启（Codex 2026-07-30 重申）

## 5. 待办（按优先级）

1. ~~验收 R2~~ **已完成（2026-07-30 SIGNED）**——范围 chat + quizAttempt，
   playback 移出 R2。签字记录：`docs/reports/2026-07-30-runtimestore-r2-signed.md`
2. ~~建立隔离 Supabase Preview/Scratch~~ **已完成（2026-07-30，Kimi/WebBridge）**——
   Vercel Preview/Production 已拆分至不同 Supabase 项目，详见 §4
3. **生成链路误分类 bug 修复**（你的地盘）：`docs/reports/2026-07-28-agent-text-action-leak.md`
4. **迁移验证**：仅在隔离环境执行 SQL，验证路由/RLS/service role/RPC EXECUTE 收口；
   通过后由负责人单独授权生产执行
5. **受控开影子写**：`NEXT_PUBLIC_RUNTIME_SHADOW=1`（chat + quizAttempt），
   观察 `runtime_shadow` 遥测（Vercel logs 搜 `runtime_shadow`），再定 SLO
6. **playback R2.1 前置设计卡**：pending/outbox、刷新及跨标签页恢复语义
   （R3 切读门禁的输入）；**然后**才立 R3 总设计稿（含 chat 完整消息语义、
   匿名写 + merge-grant 签发端用 `ac:<uuid>` 不透明 ID、灰度控制面）

## 6. 关键文件索引

| 主题 | 路径 |
|---|---|
| R2 影子写核心 | `lib/runtime/shadow-writer.ts` |
| quiz attemptId 生命周期 | `lib/quiz/persistence.ts`（ATTEMPT_ID_PREFIX） |
| playback 快照持久化 | `lib/utils/playback-storage.ts`、`lib/utils/database.ts`（PlaybackStateRecord.runtimeShadowEventId） |
| chat 挂点 | `lib/utils/chat-storage.ts` saveChatSessions |
| quiz 挂点 | `components/scene-renderers/quiz-view.tsx`（submit/graded/retry 三处） |
| playback 挂点 | `components/edit/PlaybackChromeRoot.tsx`（引擎 onProgress） |
| 遥测路由 | `app/api/client-diagnostics/route.ts`（runtime_shadow 白名单分支） |
| R1.1 服务端 | `app/api/runtime/v1/sessions/**`、`lib/server/runtime-store/*`、`lib/runtime/payload-validators.ts` |
| payload 校验映射 | `lib/runtime/payload-validators.ts`（chat→{role,content}，quizAttempt→{phase,answers}，playback 等 RJ 自有 kind app-owned 不校验） |
| 真实 PG 并发套件 | `tests/runtime-store-pg/live-pg-concurrency.test.ts` |
| R2 测试 | `tests/runtime-shadow/`（attempt-id / shadow-writer / playback-shadow，30 例） |
| R2 设计稿 v2 | `docs/reports/2026-07-29-runtimestore-r2-shadow-write-design.md` |
| R2 实施报告 | `docs/reports/2026-07-29-runtimestore-r2-shadow-write-implementation.md` |
| R1.1 签字 | `52862d2e` 的 docs commit |
| 误分类 bug 报告 | `docs/reports/2026-07-28-agent-text-action-leak.md` |

## 7. API 形状速查（R1.1 已上线于分支）

- `POST /api/runtime/v1/sessions` body `{id, kind, stageId, status, createdAt, updatedAt}`，learnerKey 服务端注入 auth.uid()，课程可读门禁（stageId==courseId）；重复 id → 409 CONFLICT
- `POST /api/runtime/v1/sessions/{id}/records` body `{id, createdAt, payload, sceneId?, actionIndex?, subAnchor?}`；幂等：同 id 同内容（**含 createdAt**）返回已有行 201，同 id 不同内容 409 IDEMPOTENCY_CONFLICT
- `PATCH /api/runtime/v1/sessions/{id}/status` body `{status, updatedAt}`，status ∈ active/completed/archived
- DSL 枚举：`ChatRuntimeRole` = user/assistant/system；`QuizAttemptPhase` = draft/submitted/reviewed；`RuntimeSessionStatus` = active/completed/archived
- 速率限制：create 30/分、append 120/分、set_status 60/分（每用户）

## 8. 与 Kimi 的协作约定

- Kimi 继续在 `D:\WorkBuddy 地界\RJ-laixue-storage-b2` 施工；若你同期改动同文件，先对齐再动手
- 评审意见按「修复卡」格式给：具体问题 → 修正建议 → 验收门禁；Kimi 按卡施工后回报告
- 需要用户操作的事（push 失败兜底、Vercel/Supabase 控制台、SQL 执行授权）由 Kimi 或你明确提出，用户只负责拍板和点击
