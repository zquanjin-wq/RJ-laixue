# Handoff Brief: RJ-laixue v0.3.1 Sync Decision

> 准备给 Claude Fable 5（网页端）的背景包。  
> 把整个文件复制到 Claude Fable 5 对话即可。

---

## 1. 项目背景

**RJ-laixue** 是锐捷大学（Ruijie University）的内训平台 fork。

- **上游**：OpenMAIC v0.3.0（清华 THU-MAIC 团队，MIT 协议，20k+ Star）
- **我们 fork**：v0.3.0 + 约 100+ 次自研 commit
- **生产部署**：Vercel 跑 [www.laixue.work](https://www.laixue.work)
- **用户画像**：锐捷内部员工，**组织内培训场景**（不是公网 SaaS）
- **核心定制**：
  - 服务端统一配 LLM/TTS provider（MiniMax MiniMax / MiniMax TTS），客户端零配置
  - Supabase Auth + RLS（不是上游默认的"用户自配"）
  - 9 个分批 SQL migration（auth-mvp / learning-mvp / rls-tighten wave1-5 / courses-owner / students-disabled）
  - 9 个 supabase-*.sql 累计 74 commits、349 files、+31k 行
  - 服务端 classroom 自动保存、admin 课程管理、Q&A 多智能体编排

**用户**：锐捷大学培训部门的人，**没研发经验**（自述）。会跑 `pnpm dev`，其他都得图形界面化。给指令必须精确到点击哪个菜单/按钮。

**协作偏好**：
- 中文沟通
- 偏好**简洁直接**，反感套话
- **起草 + 犀利评审**闭环
- **先讲思路、确认后再动手**
- **多角色协作**通过 WorkBuddy 专家/Skill 封装，不要在主对话 spawn 子 agent
- 重视产出质量，怕"思路狭窄"和"草率交差"

## 2. 这次要决策什么

**是否合并上游 v0.3.1——特别是 v0.3.1 的 RuntimeStore 重构（史诗级，跟踪 issue #869）**。

RJ-laixue 现在落后 v0.3.1（v0.3.0 是基础）。我们刚做完体验优化（自动保存/进度 UI/超时机制）3 个 PR 还没合到线上。**我们倾向先评估再决定**。

## 3. v0.3.1 RuntimeStore 重构摘要（关键信息）

v0.3.0 → v0.3.1 共 86 commits / 638 files / +92k 行。其中 **#869 RuntimeStore** 是最大的一块（贯穿整个 v0.3.1 周期）。

### 3.1 问题背景
之前所有客户端数据混在一个 Dexie IndexedDB 里：
- 没版本控制
- 没可插拔后端（无法云同步）
- chat / PBL 状态散落
- 运行时数据 vs 文档数据混在一起

### 3.2 三层架构（v0.3.1 引入）

```
┌─────────────────────────────────────────────┐
│ 应用代码 (chat / pbl / editor)                │
│   只调 storage interface，不直接碰 IndexedDB  │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│ @openmaic/storage  ←  新包                   │
│   ├─ KVStore         设备/账号作用域键值     │
│   ├─ AssetProvider   内容寻址 blob 存储     │
│   ├─ DocumentStore   文档聚合（stage+scenes）│
│   └─ RuntimeStore    运行时会话+append-only  │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│ Backend:                                    │
│   ├─ BrowserRuntimeStore    (IndexedDB)     │
│   ├─ HttpRuntimeStore       (v0.3.1 新加)   │
│   └─ Postgres backend       (reference)     │
└─────────────────────────────────────────────┘
```

### 3.3 关键 commits

| Part | commit | 内容 |
|---|---|---|
| A | `83fdecf3` | DSL envelope: RuntimeSession + RuntimeRecord + 严格 ISO 8601 校验；runtimeDslVersion 与 dslVersion 分离 |
| B | `1c507884` | RuntimeStore 接口 + BrowserRuntimeStore（IndexedDB）；事务内重新验证 record；corrupt row 跳过不污染 partition |
| B | `6d6e1ac8` | DocumentStore（stage + scenes 走 DSL-typed 路径） |
| C1 | `667f3b0c` | RuntimeStore app bootstrap；cascade stage 删除；Web Locks 跨 tab learner key |
| C2 | `5627b991` | PBL outbox：每次 learner mutation emit typed event；客户端 drainer 拷到 RuntimeSession；watermark 三元组 (stageId, sceneId, learnerKey) |
| C3 | `dd83ac86` | **读端翻面**（read flip）：stage load 时从 RuntimeStore fold 出 PBL learner state；snapshot backfill 兜底 |
| - | `65bf20a8` | **chat sessions 切到 RuntimeStore**（+6168 行 tests，跨 tab 锁、legacy migration） |
| - | `e601eaa3` | PBL learner state 切到 RuntimeStore |
| - | `34448beb` | **HTTP 后端 + Postgres reference server**（v0.3.1 末尾） |

### 3.4 ⚠️ 致命冲突点：learnerKey vs Supabase Auth

上游 v0.3.1 假设**设备匿名**身份：
```ts
const learnerKey = await getLearnerKey();  // crypto.randomUUID()
await navigator.locks.request('maic:learner-key', ...);
```

**RJ-laixue 现状**：
- 所有学员都有 Supabase Auth user
- `course_assignments.student_id = auth.uid()` 决定课程可见性
- `course_progress_events` 记录进度

合并需要决策：
- **A. 用 Supabase uid 覆盖 learnerKey**（失去跨设备匿名，但跟现有 RLS 对齐）
- **B. learnerKey 跟 auth.uid 双轨**（复杂，保留上游能力）
- **C. 等上游支持 multi-tenant 后再合**（推迟，但持续落后）

我们初步倾向 **A**——RJ-laixue 核心价值是组织内培训，匿名 learnerKey 反而是负担。

## 4. RJ-laixue 自研改动清单（按主题）

### Supabase（74 commits）
- `supabase-auth-mvp.sql`：profiles 表 + role enum
- `supabase-learning-mvp.sql`：students + course_assignments + course_progress_events
- `supabase-auth-triggers.sql`：用户注册/角色联动
- `supabase-courses-owner.sql`：courses.created_by 字段
- `supabase-students-disabled.sql`：学员禁用
- `supabase-rls-tighten-wave1.sql`：撤销 anon 写入
- `supabase-rls-tighten-wave2.sql`：courses SELECT-only
- `supabase-rls-tighten-wave5.sql`：撤销 anon SELECT
- `supabase-rls-tighten-courses-owner.sql`：course_assignments 学员只能读自己的

### Admin（79 commits）
- `/app/admin/courses/` 课程管理
- `/app/admin/students/` 学员管理
- `/app/api/admin/students/[id]/disable/` 禁用学员
- `/app/student/courses/` 学员课程列表

### Scene order（52 commits）
- `lib/utils/scene-order.ts` 场景排序 trust 机制
- `stage.sceneOrderTrusted` + `sceneOrderRepairedAt` 字段
- 历史脏数据回填

### Audio（25 commits）
- 老师音色 / TTS provider 配置
- `lib/audio/agent-voice.ts`
- 移动端连续播放

### Security（11 commits，最近）
- `lib/server/api-guard.ts` API 路由登录+角色+限速
- `lib/server/api-response.ts` 统一错误码
- `/api/courses/[id]` GET 三层权限校验（修复"猜 ID 访问别人课程"）

### Mobile（10+ commits）
- `/app/m/[id]/page.tsx` 移动端学习页
- `lib/mobile/course-data.ts`
- `lib/mobile/scene-helpers.ts`

### 其他
- 性能、UI、文档、i18n 增量

## 5. 三个选项

| 选项 | 时间投入 | 收益 | 风险 |
|---|---|---|---|
| **A. 立即合并 v0.3.1** | 1-2 周全职 | 一次到位；后续升级简单；拿到 PBL 跨设备续接 | learnerKey 跟 Supabase Auth 冲突；6k+ tests 要重跑；UX 回归 |
| **B. Cherry-pick Part A+B（架构升级，不切业务流）** | 3-5 天 | 拿到 RuntimeStore 架构 + 浏览器后端；chat/PBL 暂时不切流 | 留下技术债 |
| **C. 冻结在 v0.3.0** | 0 | 短期省事 | 落后越来越多；自研兜底逻辑（saveStageToCloud 等）最终都要换 |

## 6. 我们的初始倾向

**B**——分两步走：
- **第一期**：架构升级（Part A+B + 浏览器后端），不切 chat/PBL 流
- **第二期**：业务稳定后再做 chat/PBL 切流（Part C + 应用层 commits）

理由：
- 风险最低：业务流不变，UI 不会回归
- 拿到 v0.3.1 的核心价值（版本化 + 迁移框架 + 可插拔后端）
- 给我们时间评估 learnerKey vs Supabase Auth 冲突

## 7. 我们刚做完、还没上线的 3 个 PR

用户体验优化（commit `ac91244e` / `8b70ad9a` / `6287ae23`）：

1. **PR1 自动保存**：generation 完成后 fire-and-forget 调 `saveStageToCloud`，失败有 toast
2. **PR2 进度 UI**：替换 spinner 为 `GenerationProgress` 组件，每个 outline 状态可见
3. **PR3 超时机制**：单 outline 3min + 整体 15min watchdog，失败后重试按钮

⚠️ **这几个 PR 在 Part A 之后会被 RuntimeStore 取代**——v0.3.1 的 RuntimeStore + HTTP 后端能直接用云端持久化，不需要 fire-and-forget saveStageToCloud 的兜底逻辑。

**建议**：先把这 3 个 PR 合到生产（救火优先），再讨论 v0.3.1 合并。

## 8. 我们希望 Claude Fable 5 帮什么

1. **验证我们对 v0.3.1 RuntimeStore 的理解是否准确**（特别是 Part C 的 read flip 机制）
2. **评估三个选项的真实成本**（特别是 B 选项的 cherry-pick 冲突面）
3. **风险评估**：Part A+B cherry-pick 跟 RJ-laixue 的 Supabase + 我们的 9 个 sql 文件有没有隐藏冲突
4. **给具体下一步建议**：是先合并 3 个 PR 到生产再讨论 v0.3.1，还是可以并行

## 9. 关键文件路径（方便你 read）

如果需要查代码细节：
- 上游 RuntimeStore：`packages/@openmaic/storage/src/runtime/`
- 我们 Supabase SQL：`supabase-*.sql`（9 个）
- 我们的 auth/RLS：`lib/supabase/server.ts`
- 我们刚做的 PR：`lib/hooks/use-scene-generator.ts`（PR1+PR3），`components/generation/GenerationProgress.tsx`（PR2）
- 详细 diff 清单：`docs/diff-from-upstream.md`（人可读）+ `diff-from-upstream-files.md`（原始）

## 10. 关键 commit hash 速查

| 内容 | commit |
|---|---|
| v0.3.0 tag | `v0.3.0` |
| v0.3.1 tag | `v0.3.1` |
| DSL envelope (Part A) | `83fdecf3` |
| RuntimeStore 接口+浏览器后端 (Part B) | `1c507884` |
| DocumentStore | `6d6e1ac8` |
| App bootstrap (C1) | `667f3b0c` |
| PBL outbox (C2) | `5627b991` |
| PBL read flip (C3) | `dd83ac86` |
| Chat 切流 | `65bf20a8` |
| PBL learner state 切流 | `e601eaa3` |
| HTTP/Postgres 后端 | `34448beb` |

---

**给 Claude Fable 5 的提问**：

> 我们现在面临的核心问题是：v0.3.1 RuntimeStore 重构对 RJ-laixue 是机会还是负担？基于上面的项目背景和 v0.3.1 改动摘要，请帮我们：
> 
> 1. **指出我们漏看的关键风险**（特别是 learnerKey vs Supabase Auth 之外的问题）
> 2. **如果选 B（cherry-pick Part A+B）**，列出会跟 RJ-laixue 现有代码冲突的具体文件
> 3. **给一个明确的分阶段实施计划**（含具体 commit 顺序）
> 4. **评估 3 个 PR（PR1+2+3 自动保存/进度/超时）是否值得先合到生产**再讨论 v0.3.1
>
> 不需要立刻给完美答案——你也可以先 read 我们仓库的关键文件（git clone 下来后看 docs/diff-from-upstream.md）再给判断。RJ-laixue 在 `D:\WorkBuddy 地界\RJ-laixue`（Windows 路径）。
