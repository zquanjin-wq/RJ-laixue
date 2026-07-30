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

### R2 影子双写 ✅ 代码完工，待 Codex 验收
- 设计稿 v2：`692cf9b7`（Codex 终审 4 项拍板 + 2 个 P0 已落实，见 §3）
- 实施：`5e6c1366`（代码+30 测试）+ `4244e4ae`（实施报告 `docs/reports/2026-07-29-runtimestore-r2-shadow-write-implementation.md`）
- 门禁：68/68 新增相关测试绿；tsc 0 error；全量 2076 passed（仅 8 个存量失败）

## 3. R2 终审裁决（不可重开，已实施）

1. **字段裁剪**：chat 只带 `{role, content}`（不带 title/config/toolCalls/pendingToolCalls）；仅限 R2 影子期——影子数据不得作为未来读源或审计依据，R3 切读前另行评审完整消息语义
2. **`ac:<code>` 被拒绝**：access code 是凭证，不得作数据库分区键/grant 响应字段/日志内容；R2 不覆盖匿名写故该约定已删除；未来匿名服务端写用服务端签发的随机不透明 ID（如 `ac:<uuid>`）
3. **匿名期不影子写**：R2 只覆盖 auth.uid() 已登录用户；匿名服务端授权与迁移合并另立任务
4. **开关用环境变量** `NEXT_PUBLIC_RUNTIME_SHADOW`（默认关），不建站点配置表；灰度控制面是 R3 的事
5. **P0-1 playback**：`pb:<stageId>:<monotonic-n>` 不可靠（刷新/跨标签页复用）——每次保存先生成新 UUID `runtimeShadowEventId` 随快照**同一次 Dexie put** 持久化，record id = `pb:<stageId>:<eventId>`，重试只能复用持久化 id
6. **P0-2 quiz**：attemptId = UUID，持久化在 localStorage `quizAttemptId:<sceneId>`，与 answers 同一次写入；`clearSubmitted` 后才允许生成新值；会话 id = `qa:<stageId>:<sceneId>:<attemptId>`
7. **merge-grant 签发不入 R2**（无可合并的匿名服务端数据，保留为后续匿名 RuntimeStore 的设计前提）

## 4. 迁移前置条件（Codex 终审拍板，仍未满足）

**当前状态：生产/预览 Supabase 均未执行任何 SQL，`runtime_*` 表不存在。**

1. **硬前提：Vercel Preview 必须连接独立的 Supabase Preview/Scratch 项目**。若当前 Vercel Preview 与生产共用同一 Supabase 项目，任何「预览迁移」= 改生产库，应禁止
2. 顺序：建独立 Supabase Preview/Scratch → 仅在那里执行 SQL 并验证路由/RLS/service role/RPC EXECUTE 收口 → 通过后由负责人**单独授权**生产执行 → 生产执行前确认 runtime_* 表不存在或为空
3. 回滚语义：R2 影子写上线后如需回退，只关开关/回退代码，保留 runtime 表；**只有在「尚未写入任何业务 runtime 数据」的窗口才允许 DROP runtime_* 物理回滚**，写入后不得靠删表回滚

## 5. 待办（按优先级）

1. **【你的第一件事】验收 R2 实施报告**（`docs/reports/2026-07-29-runtimestore-r2-shadow-write-implementation.md`），重点拍板 §4 两个设计前提偏差：
   - ① quizAttempt phase 枚举：设计稿的 `answering`/`reviewing` 是本地 SubmittedState 词表，DSL 枚举实为 `'draft'|'submitted'|'reviewed'`；实施已按 DSL 枚举（否则服务端校验 400），设计稿需勘误
   - ② playback 本地持久化是死代码：设计稿假设的「保存进度到 Dexie」在 v0.3.1 rebase 后不存在（`savePlaybackState` 全仓无调用方）。处置：影子路径仅在开关开启时恢复该本地写入（eventId 随快照同一次 put），开关关闭时与现状逐字节一致。认可此处置，还是要求 playback 移出 R2 单独立项？
2. **生成链路误分类 bug 修复**（你的地盘）：`docs/reports/2026-07-28-agent-text-action-leak.md`
3. **迁移路径**：满足 §4 前置条件后，受控环境开 `NEXT_PUBLIC_RUNTIME_SHADOW=1`，观察 `runtime_shadow` 遥测成功率分布（Vercel logs 搜 `runtime_shadow`），再定 SLO
4. **R3（切读源）设计稿立项**，至少覆盖：chat 完整消息语义（toolCalls/config 是否保存）、playback record 量级/聚合策略、弱网 outbox/重试/幂等门禁、何时允许从 Dexie 读源切到 RuntimeStore、匿名写 + merge-grant 签发端（redeem 对接，用 `ac:<uuid>` 不透明 ID）、课程→学员灰度控制面

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
