# edit_elements 元素级 AI 编辑 —— 实施报告

> 2026-07-28 · 责任人：Kimi（分工：edit_elements 上游评估、方案与实施）
> 分支：`feat/element-editing-v031` · 基线 tag：`pre-element-editing-baseline`
> 决策依据：`docs/reports/2026-07-28-merge-vs-cherry-pick-decision.md`（方案 C 轨道 1）

---

## 1. 实施内容

从 OpenMAIC v0.3.1 定向 cherry-pick 元素级编辑 5-commit 链（合计 ~18k 行）：

| 本地 commit | 上游 | 内容 | 冲突 |
|---|---|---|---|
| `b99ad396` | `191689f9` (#859) | 渲染器 v2：元素选择 + 拖拽移动 | 仅 pnpm-lock |
| `9b4b87bb` | `ff300b07` (#881) | 8 点缩放 + 旋转手柄 | 无 |
| `612e1468` | `09f490cf` (#888) | 框选多选 + 多元素拖拽 | 无 |
| `5266da2e` | `cc5a6ab1` (#896) | `edit_elements`：NL → EditIntent（typebox RFC 6902 契约） | 无 |
| `386dfde9` | `ebb12b5f` (#927) | 带校验 JSON Patch 元素编辑 | 无 |

- `edit_elements` 已自动进入 `V0_ALLOWLIST`（第 5 个工具），与现有 4 工具共用同一 pi-agent 框架、同一服务端模型解析路径（`resolveModelFromRequest` → MiniMax）
- 对 RuntimeStore/DocumentStore **零依赖**，与 Codex 的 B2 线无冲突面

## 2. 验证证据（全绿）

| 验证项 | 结果 |
|---|---|
| `scripts/check-i18n-keys.mjs` | ✅ 8 locale 全过 |
| edit_elements 测试套件（gate 82 + patch 33 + render-contract 6 + tools 4） | ✅ **125/125** |
| `@openmaic/renderer` 全量测试（含 editing 手柄/手势/几何） | ✅ **223/223**，20 文件 |
| Vercel Preview 构建（`386dfde`，含完整 Next build + TypeScript） | ✅ **Ready** |
| main 基线 tsc | ✅ 0 错误（cherry-pick 前） |

## 3. 依赖变更

- 新增运行时依赖：`sanitize-html@2.17.0` + `@types/sanitize-html`（JSON Patch 消毒）
- renderer 新增 devDependencies：`@testing-library/react` / `@testing-library/dom`
- ⚠️ lockfile 冲突解决时带入上游 `@supabase/ssr 0.12.0→0.12.3`、`@supabase/supabase-js 2.110.1→2.110.9` 小版本升级——合并 main 前留意 Supabase 行为回归（Auth cookie 处理是 RJ 敏感区）

## 4. ⚠️ 合并 main 前必须处理的两个 fork 集成缺口

### 4.1 ~~`/api/agent/edit` 无 api-guard~~（已修复，`e372d266`）

- 上游该路由**零鉴权**（上游是 BYOK 模型，用户烧自己的 key）；RJ 是服务端统一配 MiniMax，**未鉴权调用会直接烧 RJ 的 LLM 配额**
- 处置已完成：接 `requireAuthOrTeacher(['teacher','admin'])` + `rateLimitByUser(uid, 'agent-edit', 10, 60s)`，guard 在 body 解析之前；4 个独立测试覆盖拒绝路径与顺序（`tests/server/agent-edit-route-guard.test.ts`，4/4 通过 + tsc 双通过，合规约 §3）

### 4.2 ~~编辑器开关语义错位~~（排查完毕，无需改代码）

- 实证：`agentEnabled = authoringEnabled || scene.type === 'interactive'`（`EditChromeRoot.tsx:83`）——agent 面板由**场景能力注册表**驱动，不读 env flag；它挂载在 RJ 老师生产在用的 EditChromeRoot 右栏（`RightRailTabs`）
- env flag `NEXT_PUBLIC_MAIC_EDITOR_ENABLED` 只门控 EditChromeRoot 本身是否渲染——RJ 生产编辑器在用 ⇒ 该 flag 在 Vercel 必已为 `true`（CLAUDE.md"不再用"指的是已删除的旧拼写 `MIAC` flag）
- 结论：**无需改代码**，agent 面板会随编辑器表面自然出现；最终确认并入 owner 冒烟清单

## 5. 未验证项（不影响代码正确性，影响体验）

| 项 | 状态 | 责任人 |
|---|---|---|
| 线上 4 工具 AI 编辑面板在 MiniMax 下工作正常 | owner 实测中 | 培训部门 |
| MiniMax M2.7 的 RFC 6902 JSON Patch 输出质量（"好不好用"） | 未测——需在 preview 环境真实 UI 冒烟 | Kimi 配合 |
| `edit_elements` 端到端（prompt → patch → 画布应用 → 撤销） | 待 preview 冒烟 | Kimi 配合 |

## 6. 事故与处置记录（2026-07-28 中午）

| 时间 | 事件 |
|---|---|
| 12:03 | laixue-bot（另一 WorkBuddy 会话）将 `wip/course-assets-externalization` merge 进 main 并推送，Vercel production 构建失败（WIP 含 11 个已知 tsc 错误，commit 已标注"未经完整功能验证"） |
| 12:32 | Kimi revert 该 merge（`271db68e`）并推送 → production 恢复 **Ready** |
| 12:51–13:2x | 另一 WorkBuddy 会话 fix-forward（`3d80b985`/`31c48b3e`/`dbfcfec8`），修的正是 tsc 查出的错误类（MATERIAL_MAX_HUMAN 导入 / ApiErrorCode / ProviderId 类型），main 当前 = `dbfcfec8`（origin 同步），其构建绿否以 Vercel 为准 |

**教训沉淀**：WIP 分支名 + commit message 不足以防止误合——建议 main 开 GitHub 分支保护（强制 PR + 状态检查）。

## 7. 下一步

1. ~~Kimi 补 §4.1 api-guard~~ ✅ 已完成（`e372d266`）
2. ~~确认 §4.2 开关语义~~ ✅ 排查完毕，无需改代码
3. owner 在 Vercel preview（`feat/element-editing-v031`）冒烟，清单：
   - 打开 `/classroom/[id]?editor=1`，确认右栏 AI 面板出现
   - 4 个旧工具回归（重生成场景/交互页编辑）
   - **`edit_elements` 端到端**："把标题改成红色"类指令 → JSON Patch → 画布精准应用 → 撤销可用（MiniMax M2.7 Patch 质量的最终考场）
   - 未登录/learner 访问 `/api/agent/edit` 应 401/403（api-guard 生效）
4. 冒烟通过 → PR 合 main（建议顺手开 main 分支保护，见 §6 教训）
