# RJ-laixue 项目状态

> 维护者：研发协作  
> 最近更新：2026-07-24  
> 配套文档：`docs/CLAUDE.md`（AI 协作项目记忆） / `docs/reports/`（阶段报告） / `docs/diff-from-upstream.md`（与 OpenMAIC 差异）

---

## 当前阶段

**Phase 0 完成 ✅**，准备进入 **Phase 1+2**（RuntimeStore 架构 cherry-pick）。

| 阶段 | 状态 | 报告 |
|---|---|---|
| Phase 0 — 救火 + 安全 + 基线 | ✅ 完成 | [2026-07-24-phase0.md](reports/2026-07-24-phase0.md) |
| Phase 1+2 — RuntimeStore + DocumentStore cherry-pick | ⬜ 待启动 | — |
| Phase 3 — learnerKey 决策 spike | ⬜ 待启动（与 Phase 1+2 并行） | — |
| Phase 4 — 31 文件切流 + SupabaseRuntimeStore | ⬜ 业务平稳期另立项 | — |

---

## 关键决策记录

### ✅ 已拍板（按时间倒序）

| 决策 | 日期 | 理由 | 记录位置 |
|---|---|---|---|
| **Phase 0 修开关位置**：从 `fireAndForgetAutoSave` 函数内部上移到调用点 | 2026-07-24 | saveStageToCloud 有 3 个调用点（自动 / 顺序修复回传 / 手动按钮），开关只管"自动"那条 | commit `21712c39` |
| **Next_PUBLIC_LEGACY_AUTOSAVE 命名 + 默认开** | 2026-07-24 | 语义准确；保留 PR1 行为；设 `=0` 关闭 | commit `21712c39` |
| **59a8bac6 SSRF 修复搁置**（v0.3.1 #930） | 2026-07-24 | modify/delete 冲突：`probe-auth.ts` 在 RJ-laixue 已删，改走 `api-guard` 路线 | Phase 0 报告 §二 |
| **Phase 1+2 修正版 B（cherry-pick Part A+B）** | 2026-07-24 | 三 commit cherry-pick 实测 0-3 冲突，seq 风险需"写端归一"或"读端 wrapper"修 | `docs/reports/2026-07-24-independent-review.md` |
| **learnerKey 决策**：v0.3.1 默认走 `learnerKey = crypto.randomUUID()` 不适合 RJ-laixue | 2026-07-24 | 内训平台每个学员有 Supabase Auth；`learnerKey = auth.uid()` 更贴合 | `docs/HANDOFF-FOR-CLAUDE-FABLE-5.md` §3.4 |
| **RuntimeStore 是机会不是负担** | 2026-07-24 | 上游用 9.2 万行解决的正是 RJ-laixue 自研兜底想解决的事 | `docs/DRY-RUN-V031-MERGE-REPORT.md` |

### ⏳ 待拍板

| 决策 | 触发时机 | 备注 |
|---|---|---|
| **seq 风险修复方案**：写端归一（推荐）vs 读端 wrapper vs 双保险 | Phase 1+2 启动前 | Fable 5 推荐写端归一 |
| **PR1+2+3 是否立即上生产** | Phase 0 完成 | Vercel preview 冒烟确认 |
| **api-guard.ts 是否覆盖 media adapter 出站 URL 拉取** | Phase 4 启动前 | 关联 59a8bac6 搁置决策的兜底验证 |

### 📋 Backlog

- [ ] api-guard.ts 覆盖 media adapter（kling/seedream）出站 URL 验证
- [ ] 上游 v0.3.1 完整同步评估（独立 PR review）
- [ ] PR1+2+3 + LEGACY_AUTOSAVE 开关在 Vercel preview 实测（本地 build 阻塞）

---

## main 分支当前状态

```
6d7142a1 fix(ssrf): harden provider redirects and ISATAP detection (#928)   ← HEAD
21712c39 chore: PR1 autosave 加 NEXT_PUBLIC_LEGACY_AUTOSAVE 开关
92904f72 docs: v0.3.1 cherry-pick 冲突预检报告
431a221e docs: v0.3.1 merge dry-run 冲突清单报告
e428c4ab chore: 加 Supabase schema 自动 dump workflow
e0fa358c chore: 维护周 - 上游差异清单 + CLAUDE.md + README 锐捷定制说明
6287ae23 PR3: 生成超时机制（单页 3min + 整体 15min）
8b70ad9a PR2: 生成过程实时进度 UI（每个 outline 状态可见）
ac91244e PR1: 生成完成后自动保存到云端（fire-and-forget）
bfe7cae3 i18n: 修正老师主页文案位置（误改回滚 + 重新分配）
```

**Tag**：`pre-runtimestore-baseline` (6d7142a1)

---

## 操作规约（铁律）

### 1. `git reset --hard` 铁律

> **2026-07-24 今日两次违反此规约导致工作差点/真的丢失**：
> - 第一次：工作树里 LEGACY_AUTOSAVE 开关改动被 reset 清掉（独立评审发现并修正）
> - 第二次：cp/ssrf-1 分支上 commit 67e92657 被 reset 清掉（用户发现后重做）

**`git reset --hard` 前必须自查**：

1. 当前分支是否有未合入 main 的 commit？
   - 是 → 先 merge 或打 tag
2. 工作树是否有未提交改动？
   - 是 → 先 `git stash` 或 commit
3. 两者任一存在 → **不** reset

**例外**：明确知道要丢弃的废弃分支 → `git branch -D <branch>` 删分支，不需要 reset。

### 2. 拍板类结论及时入库

拍板类结论（如"59a8bac6 搁置"、"LEGACY_AUTOSAVE 默认开"）必须当天进入本文档"关键决策记录"区域，否则会重复询问/拍板。

### 3. SSRF / 安全相关 commit 必须独立测试

cherry-pick 安全类 commit 后：必须跑该 commit 自带的测试文件 + 主干 tsc，**双重通过**才进 main。

### 4. 改"调用点" vs 改"函数内部"

新增 feature flag / 开关时，**优先在调用点加**（明确局部化作用域），不在共享函数内部加（容易误伤其他调用方）。判断标准：开关影响的范围 = 多少个调用方？1 个 → 函数内 OK；>1 个 → 调用点分别加。

### 5. 不顺手重构

"看不顺眼" ≠ "需要改"。Phase 0 任务卡明确"不碰 packages/@openmaic/*" + "不顺手重构"。

---

## 未解决问题 / 阻塞

### Build 环境配置阻塞

```
Error: Initiated Worker with invalid NODE_OPTIONS env variable:
--use-system-ca is not allowed in NODE_OPTIONS
```

- **影响**：本地 `npx next build` 失败，Vercel preview 冒烟无法在本地进行
- **与本次代码无关**：Vercel 部署环境继承的 `NODE_OPTIONS` 配置问题
- **建议解决**：Vercel Dashboard → Project Settings → Environment Variables → 找到 `NODE_OPTIONS`，删掉 `--use-system-ca`（或整个变量）

---

## 关键基础设施

- **上游同步**：`git remote -v` → `upstream = https://github.com/THU-MAIC/OpenMAIC.git`
- **tags**：`v0.3.0` / `v0.3.1`（已 fetch）
- **Supabase 9 SQL**：按顺序应用 `supabase-learning-mvp.sql` → `supabase-auth-mvp.sql` → ...
- **PR 跟踪**：本周已合的 3 个 PR（PR1-3）已在 main，未推到 origin/main

---

## 联系 Fable 5 / 上游同步

- `docs/HANDOFF-FOR-CLAUDE-FABLE-5.md`：项目背景包
- `docs/diff-from-upstream.md`：与 v0.3.0 的差异（人可读）
- `docs/diff-from-upstream-commits.md` / `docs/diff-from-upstream-files.md`：原始 git log
- `docs/DRY-RUN-V031-MERGE-REPORT.md`：v0.3.1 全量 merge dry-run
- `docs/runtimestore-conflict-scan.md`：Phase 1+2 cherry-pick 实测
