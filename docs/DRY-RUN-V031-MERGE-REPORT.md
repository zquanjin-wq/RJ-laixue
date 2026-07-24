# v0.3.1 Merge Dry-Run Report

> 2026-07-24 · 在 `dry-run/v0.3.1-merge` 分支上跑 `git merge --no-commit v0.3.1` 后记录，已 `git merge --abort` 恢复 main。
>
> 目的：评估 RJ-laixue 合并 OpenMAIC v0.3.1 的真实冲突面，不做实际合入。

## TL;DR

| 维度 | 数字 |
|---|---|
| 冲突文件 | **18 个** |
| 总冲突 hunk 数 | **24**（含 pnpm-lock 6 个） |
| 代码文件 | 11 个 |
| 配置文件 | 3 个（package.json + 8 个 locale） |
| Lockfile | 1 个（pnpm-lock 6 hunks） |
| 业务逻辑大改 | 2 个（classroom page 3 hunks / stage-storage 2 hunks） |
| 接入新依赖 | 1 个（`@openmaic/storage` workspace 包） |

**结论**：**真要全量合并 v0.3.1 ≈ 1-2 周全职**。其中：
- 8 个 locale 冲突**可脚本化**（key 集合并集）
- pnpm-lock 重生成即可（5 分钟）
- 真正的体力活是 4 个 TS 业务文件：classroom page / stage-storage / database / settings

---

## 完整冲突清单（按风险排序）

### 🔴 P0 — 业务核心，必须 review（高风险）

#### 1. `app/classroom/[id]/page.tsx`（3 hunks，158-569 行大块）

- **HEAD 端**：RJ-laixue 加了 `loadClassroom` 用 IndexedDB + Supabase，scene order 自愈逻辑
- **v0.3.1 端**：完整重写 `loadClassroom`，支持 `isEffectCurrent` flag（防 race condition）+ PBL read flip + RuntimeStore fold
- **风险**：这是 v0.3.1 最大的业务变更；合并需**理解 PBL 折叠机制**才能正确处理 conflict
- **预估解决时间**：1-2 天（要先读懂 #869 Part C3 的 fold 逻辑）

#### 2. `lib/utils/database.ts`（2 hunks，行 251/477）

- **HEAD 端**：`v14`，scenes 加 `seq` 字段（scene order 自愈体系），自研改动
- **v0.3.1 端**：`v15`，`v14` 加 `chatStorageLocks`（chat 跨 tab 锁），`v15` 加 `chatRestoreStaging`（chat 备份恢复）
- **冲突本质**：**两套 schema 演进路径不兼容**。HEAD 在 v13 加 `seq`；v0.3.1 在 v14 加了又撤了 chatStorageLocks
- **合并策略**：v15 = max(14, 15) = 15，**保留 HEAD 的 v13 升级 + v0.3.1 的 v14 升级 + v0.3.1 的 v15 升级**。但 v0.3.1 不知道 `seq` 字段——要手动加 `[stageId+seq]` 索引
- **预估解决时间**：半天（但必须测 IndexedDB 真实升级路径，否则用户数据丢失）

#### 3. `lib/utils/stage-storage.ts`（2 hunks，56-183 行大块）

- **HEAD 端**：保存 stage 时写入 `sceneOrderTrusted` + `sceneOrderRepairedAt` 字段（之前 scene order 自愈 commit）
- **v0.3.1 端**：stage 保存逻辑基本没变，但**完全没这两个字段**——RJ-laixue 独有的 schema 扩展
- **风险**：合并后如果丢了 HEAD 的字段写入，自愈体系失效但不会崩溃（数据兼容）；但如果忘了删 v0.3.1 的旧代码，重复 put
- **合并策略**：保留 HEAD 字段，v0.3.1 的 code 改动（如果有）apply 到 HEAD 端代码
- **预估解决时间**：2-3 小时

#### 4. `lib/store/settings.ts`（1 hunk，1442 行附近）

- **HEAD 端**：server-only `{}` 时的 fallback（RJ-laixue 加的"服务端统一配"兜底）
- **v0.3.1 端**：`loadEnvSection` 增加 `keylessProviders` 参数
- **风险**：逻辑可以共存——v0.3.1 的 keyless providers + HEAD 的 fallback 是不冲突的两个增强
- **合并策略**：取 HEAD + v0.3.1 的并集
- **预估解决时间**：1 小时

### 🟡 P1 — 可接受 v0.3.1（低风险）

#### 5. `lib/hooks/use-scene-generator.ts`（1 hunk，167-279）

- v0.3.1 新加 `errorMeta()` 工具函数（把 errorCode/statusCode 提到 result 顶层）
- HEAD 没这函数——**接受 v0.3.1 即可**
- **预估解决时间**：5 分钟

#### 6. `lib/server/provider-config.ts`（1 hunk，478-485）

- v0.3.1 给 `loadEnvSection(WEB_SEARCH_ENV_MAP, ..., { keylessProviders: new Set(['brave', 'searxng']) })`
- HEAD 没这参数
- **接受 v0.3.1**——keyless providers 是真功能，跟服务端统一配不冲突
- **预估解决时间**：5 分钟

#### 7. `lib/utils/image-storage.ts`（1 hunk，211-274）

- v0.3.1 把 PDF blob helpers 改名：`storePdfBlob` → `storeDocumentBlob`（同步更新 import）
- HEAD 用 `loadPdfBlob`/`storePdfBlob`
- **合并策略**：HEAD 端用旧名 → 改为新名（v0.3.1 是从 PDF 扩展到任意 document 的重构，方向正确）
- ⚠️ **检查所有调用方**——可能 `lib/utils/generation-pipeline.ts` / `lib/import/*` 都要改
- **预估解决时间**：1-2 小时（含 grep 所有调用方）

#### 8. `app/api/generate/scene-content/route.ts`（1 hunk，行 28-30）

- HEAD 有 `import { requireAuthOrTeacher, rateLimitByUser } from '@/lib/server/api-guard'`（**PR1 安全加固**）
- v0.3.1 没这 import——自己没加 auth
- **合并策略**：HEAD 端保留 api-guard import + 调用，**确保 v0.3.1 的所有 /api/generate/* 路由都接上 api-guard**（这正是 PR1 的初衷）
- **预估解决时间**：1 小时（顺手检查所有 8 个 /api/generate/* 路由）

#### 9. `app/generation-preview/page.tsx`（1 hunk，行 29-33）

- v0.3.1 把 `loadPdfBlob` → `loadDocumentBlob`
- HEAD 还用 `loadPdfBlob`
- **接受 v0.3.1**——同 #7
- **预估解决时间**：30 分钟

#### 10. `package.json`（1 hunk，行 67-70）

- v0.3.1 加 `@openmaic/storage: workspace:*`
- HEAD 没有
- **接受 v0.3.1**——这是 RuntimeStore 包的依赖入口
- **预估解决时间**：1 分钟（外加 pnpm install）

### 🟢 P2 — 8 个 locale，可脚本化（极低风险）

#### 11-18. `lib/i18n/locales/{zh-CN,zh-TW,en-US,ja-JP,ko-KR,pt-BR,ru-RU,ar-SA}.json`（每个 1 hunk）

- HEAD 端有 `progress.*` + `timeout.*` 块（PR2/PR3 加的）
- v0.3.1 端有 `analyzingMediaMaterial` 块
- **冲突本质**：key 集合并集
- **合并策略**：直接两个块都保留——JSON merge 是"加 key 不冲突"
- **预估解决时间**：30 分钟（用脚本批量合并比手工快）
- ⚠️ **必须**合并后再跑 `node scripts/check-i18n-keys.mjs` 验证

### ⚪ P3 — Lockfile

#### 19. `pnpm-lock.yaml`（6 hunks，27595 行）

- **不需要手工解决**——`pnpm install` 会自动重新生成
- **预估解决时间**：5 分钟

---

## 总结

| 工作类别 | 文件数 | 预估时间 |
|---|---|---|
| P0 业务逻辑（需 review） | 4 | 2-3 天 |
| P1 接受 v0.3.1 | 5 | 半天 |
| P2 i18n 合并 | 8 | 30 分钟（脚本化） |
| P3 lockfile | 1 | 5 分钟 |
| **合计** | **18** | **3-4 天** |

⚠️ **重要提醒**：
- 上述时间**不含**测试时间和回归排查
- 真实工作量 = 解决冲突（3-4 天）+ 测试（2-3 天）+ 修复回归（1-2 天）= **1-1.5 周全职**
- 还有我们没看到的隐藏冲突——比如 9 个 supabase-*.sql 跟 v0.3.1 的运行时有没有 schema 命名冲突（需要更细的 SQL diff）
- 我们的 api-guard 还没接 8 个 /api/generate/* 路由（PR1 只接了 /api/generate-classroom），合并时是个 hook 时机

## 给 Claude Fable 5 的建议决策点

合并 v0.3.1 之前需要先决定：

1. **冲突解决策略**：是手工逐文件解决，还是用 `git rerere` 自动记录常用合并？
2. **DB schema 顺序**：v13 (HEAD 加 seq) → v14 (v0.3.1 加 chatStorageLocks 后撤) → v15 (v0.3.1 加 chatRestoreStaging) 的合并 migration 怎么写？
3. **api-guard 全覆盖**：合并时是否借机把 8 个 /api/generate/* 全部接上 api-guard？
4. **i18n 顺序**：先合 i18n（最快），再合 P1（低风险），最后 P0（业务核心）？
5. **测试策略**：合并后是跑现有测试套（6k+ tests 上游加的）还是先 smoke test？
6. **回滚预案**：如果 v0.3.1 跑不通，回滚到 v0.3.0 + 我们的 PR1/2/3 的最低方案是什么？
