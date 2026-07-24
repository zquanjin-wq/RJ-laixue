# RJ-laixue 与上游 OpenMAIC v0.3.0 的差异清单

> **生成时间**：2026-07-24
> **对比基准**：`v0.3.0` tag（`da0b394b`）
> **当前 head**：`main` 分支
> **统计**：205 个 commit（其中 203 个非 merge）/ 349 文件 / +31461 行 / -1511 行 / 0 文件删除

---

## 一、整体对比

| 维度 | 上游 v0.3.0 | RJ-laixue fork | 差异 |
|---|---|---|---|
| Commits | 357 | 562+ | +205（fork 自研） |
| 文件 | - | - | 187 新增 / 162 修改 / 0 删除 |
| 代码行 | - | - | +31461 / -1511 |
| 默认数据库 | 无（OpenAI 直连） | **Supabase**（auth + pg） | 核心变化 |
| 部署 | 自部署 / Docker | **Vercel + Supabase** | 部署架构变化 |
| 用户体系 | 单一角色 | **admin / teacher / learner** 三级 | 新增 |
| 课程所有权 | 无 | **created_by uuid 字段 + RLS** | 新增 |
| 学员/学员工号 | 无 | **students 表 + access_code 6位** | 新增 |
| 课程分发 | 单一 URL | **course_assignments + access_code redeem** | 新增 |

---

## 二、按主题分类的 fork 提交

> 数字为该主题命中的 commit 数量（grep 重叠不可避免，仅作量级参考）

### 1. Supabase / 数据库 / 鉴权（74 commits）—— 锐捷定制核心

#### 新增的 9 个 SQL 文件（按应用顺序）

| 文件 | 作用 | 状态 |
|---|---|---|
| `supabase-learning-mvp.sql` | learning schema（students / course_assignments / progress_events）+ 早期 anon RLS | 已应用 |
| `supabase-auth-mvp.sql` | profiles 表（id 引用 auth.users）+ role check (admin/teacher/learner) | 已应用 |
| `supabase-courses-owner.sql` | courses 表加 created_by uuid 字段 + 索引 | 已应用 |
| `supabase-auth-triggers.sql` | profiles 自动创建 trigger（auth.users insert 时建 profile） | 已应用 |
| `supabase-rls-tighten-wave1.sql` | 撤销 anon 对 students / course_assignments / events 的写权限 | 已应用 |
| `supabase-rls-tighten-wave2.sql` | courses 表启用 RLS（限 SELECT-only for anon） | 已应用 |
| `supabase-rls-tighten-wave5.sql` | 撤销全部 anon SELECT（所有读写走 `/api/*` + service_role） | 已应用 |
| `supabase-students-disabled.sql` | students.disabled_at 字段 | 已应用 |
| `supabase-rls-tighten-courses-owner.sql` | course_assignments SELECT 收紧（learner 只能读自己被分配的） | 待应用 |

**注意**：9 个 SQL 是分批打的补丁——> **强烈建议导出当前完整 schema**（`supabase db dump`）作为单一 source of truth，否则新接手的开发者（包括 AI）很难拼出数据库真实现状。

#### 新增的 Supabase 配套代码

- `lib/supabase/`（约 15 文件）：server / client / admin 三套 client
- `app/api/admin/students/*`：admin 增删改查学员的 API（创建、启用、禁用、重置密码）
- `app/api/admin/teachers/*`：同上，老师管理
- `app/api/access-code/redeem/route.ts`：学员用 access_code 6 位码登录
- `app/api/learning/verify/route.ts`：学员身份验证
- `app/api/learning/events/route.ts`：学习进度事件采集

### 2. 管理员界面（79 commits）—— 锐捷定制的另一核心

| 路径 | 作用 |
|---|---|
| `app/admin/page.tsx` | admin 仪表盘 |
| `app/admin/courses/page.tsx` | admin 视角的课程列表（cross-author 浏览） |
| `app/admin/students/page.tsx` + 2 个组件 | 学员管理 UI |
| `app/admin/teachers/page.tsx` + 2 个组件 | 老师管理 UI |
| `components/auth-gate.tsx` | 路由级 auth/role 守卫组件 |
| `components/learning-manager.tsx` | 课程-学员分配管理 |

### 3. 场景顺序 / stage 渲染（52 commits）—— 最复杂的一次重构

这是 fork 中**最复杂的一次重构**——修复历史课程 scenes.order 字段不可靠的问题。

- 增加 `stage.sceneOrderTrusted: boolean` + `sceneOrderRepairedAt: number`
- 加载 stage 时根据 trusted 标记决定用 `prefer: 'auto'`（信任 seq）还是 `prefer: 'createdAt'`（一次性 repair）
- `loadStageData` 引入 repair 逻辑
- 写入路径（setScenes / self-heal / `?repairOrder` URL 参数）都设 trusted=true
- 修正了 `saveStageData` 字段白名单漏洞（之前漏了 `sceneOrderTrusted` / `sceneOrderRepairedAt`——commit `fb9a36b3`）

**危险教训**：不能无条件 `scenes.sort((a,b) => a.order - b.order)`，历史课程 order 可能不完整/不唯一/缺失/与真实顺序不一致。

### 4. 音频 / TTS / 音色（25 commits）—— AI 教师音色 bug 修复

- `lib/audio/` 新增 agent-voice、provider-enablement、tts-utils 等
- 修了一个重要 bug：课程创建时（preset 模式）只保存 `agentIds`，从不保存 AI 教师音色 → Q&A 链路 fallback 到 LLM 生成的 teacher agent.voiceConfig
- 关键 fix：服务端保存 stage 时强制写入 `teacherVoiceConfig`
- 引入 publish local audio URL 流程（commits `fix-publish-local-audio-url` 分支）
- 引入云端音频 3 层策略（audioUrl → IndexedDB blob upload → 实时 TTS）

### 5. 安全 / 权限（11 commits）—— RLS 加固 + 接口防刷

- `lib/server/api-guard.ts`：`requireAuthOrTeacher()` + `rateLimitByUser()` 工具
- 9 个 AI 生成接口加登录+角色+限速
- `/api/courses/[id]` GET 加 3 层权限校验（修复前任何登录用户能猜测 ID 拿到任意课程）
- `docs/SECURITY-CHECKLIST-2026-07-23.md` 完整记录

### 6. 移动端学习（30+ commits）

- `app/m/[id]/page.tsx`：移动端学习页
- `lib/mobile/course-data.ts`：移动端数据访问
- `docs/PRD-mobile.md`：移动端产品需求
- ⚠️ **风险**：`lib/mobile/course-data.ts` 直接用 service_role key——目前安全（仅 RSC 调用），但脆弱

### 7. 性能 / 场景顺序 bug

- 上游 scenes 排序用 `order` 字段
- fork 发现历史课程 order 不可靠（中毒 seq 复活 bug）
- 多次迭代：collectStageData sortBy('seq') → sortBy('createdAt') 临时方案 → 引入 trusted 标记长期方案

### 8. UI / 交互（30+ commits）

- 教师端首页最小可用重构：解决"两个我的课程"和按钮文案混乱
- 课程创建流程（`app/generation-preview/`）的多项调整
- 编辑器相关调整（`components/edit/`）

### 9. 文档（12 commits）

- 新增 `docs/PRD.md` / `docs/PRD-mobile.md` / `docs/AI-TEACHER-VOICE.md` / `docs/DEV.md` / `docs/README-public.md` / `docs/RELEASE-NOTES-2026-07-21.md` / `docs/SECURITY-CHECKLIST-2026-07-23.md` / `docs/audio-cloud-publish-log.md` / `docs/product-intro.html` / `docs/user-manual.html`
- 移除（？）`render-service/`：上游早期版本存在的目录，v0.3.0 已无；可能在更早 fork 时删除（git history 需深挖）

### 10. i18n（少数）

- 已有 8 个 locale（zh-CN, zh-TW, en-US, ja-JP, ko-KR, pt-BR, ru-RU, ar-SA）
- fork 期间加了一些键（老师视角文案、进度 UI、timeout 提示等）

### 11. 其他

- 部署配置：`.github/workflows/publish-packages.yml` / `Dockerfile` / `vercel.json` 微调
- `.gitignore` 加入 `/data`（防止 Vercel ephemeral fs 内容进 git）
- `.npmrc` 加入 pnpm 配置

---

## 三、新增/修改文件按目录分布

### 新增的目录（fork 独有）

```
app/admin/                  — 管理员界面（锐捷定制）
app/api/admin/              — 管理员 API
app/api/access-code/         — 学员工号 redeem
app/api/audio-upload/        — 音频上传
app/api/courses/             — 课程云端 API
app/api/extract-document/    — 文档抽取
app/api/learning/            — 学习事件
app/api/provider/            — LLM provider 配置
app/api/students/            — 学员管理
app/api/usage/               — 用量统计
app/invite/                  — 邀请页
app/login/                   — 登录页
app/m/                       — 移动端学习
app/student/                 — 学员端
docs/                        — 文档（10+ 文件）
supabase-*.sql               — 9 个数据库补丁
components/auth-gate.tsx
components/learning-manager.tsx
components/cloud-courses.tsx
components/student-gate.tsx（已删除——被 Supabase Auth 替代）
components/edit/AgentsView
components/edit/ActionsBar
components/edit/scene-timeline.ts
components/settings/token-plan-settings.tsx
components/settings/usage-dashboard.tsx
components/generation/GenerationProgress.tsx
```

### 大量修改的目录

```
app/api/generate/    — 9 个 AI 生成接口（+ 限速 + 鉴权）
app/classroom/       — 教室页（多次重构：顺序、播放、SSO 集成）
app/page.tsx         — 教师端首页（重构）
lib/store/stage.ts   — Zustand store（scene 顺序逻辑）
lib/utils/database.ts — IndexedDB schema（生成 stage generationComplete 字段）
lib/supabase/        — Supabase clients
lib/server/          — 服务端工具（classroom generation / job runner / RLS guard）
```

---

## 四、关键文件清单（fork 引入，按重要度）

### 必须读懂才能接手

| 文件 | 重要性 | 说明 |
|---|---|---|
| `supabase-*.sql` (9 个) | ⭐⭐⭐⭐⭐ | 数据库 schema 全在这；9 个文件按顺序读 |
| `lib/store/stage.ts` | ⭐⭐⭐⭐⭐ | Zustand store；scene 顺序逻辑、生成状态、RLS-aware 读 |
| `lib/utils/database.ts` | ⭐⭐⭐⭐ | IndexedDB schema（store 持久化） |
| `lib/utils/cloud-sync.ts` | ⭐⭐⭐⭐ | saveStageToCloud 是核心保存函数 |
| `lib/hooks/use-scene-generator.ts` | ⭐⭐⭐⭐ | 主生成 hook（含 PR1/2/3 的全部改动） |
| `lib/server/api-guard.ts` | ⭐⭐⭐⭐ | 登录+角色+限速（PR1 加的） |
| `app/admin/*` | ⭐⭐⭐ | 锐捷定制 admin 端 |
| `app/m/[id]/page.tsx` + `lib/mobile/course-data.ts` | ⭐⭐⭐ | 移动端学习（有 service_role 风险） |
| `app/api/courses/[id]/route.ts` | ⭐⭐⭐ | PR1 修过 3 层权限校验 |
| `docs/PRD.md` + `docs/PRD-mobile.md` | ⭐⭐⭐ | 产品需求 |
| `docs/SECURITY-CHECKLIST-2026-07-23.md` | ⭐⭐ | 安全加固记录 |

### 参考价值（业务逻辑）

- `lib/audio/` —— TTS/音色/provider-enablement
- `app/classroom/[id]/page.tsx` —— 教室页（含学习播放、Pro mode、SSO 集成）
- `components/canvas/canvas-area.tsx` —— Canvas 渲染（含 PR2 进度 UI 挂载点）

---

## 五、推荐的下一步维护工作

1. **导出 Supabase 完整 schema**（`supabase db dump`）作为 source of truth，避免 9 个 SQL 文件散落
2. **评估同步上游 v0.3.1**：上游从 v0.3.0 到 v0.3.1 约 357→新版本的 commits，含 SSRF 加固（安全）和 Postgres 运行时存储等
3. **拆分 CLAUDE.md** 让 AI 协作时能快速理解项目
4. **更新 README** 标注锐捷定制内容
5. **移除/重构 render-service/**：上游早期目录，v0.3.0 已无残留，但 git history 可能还有痕迹

---

## 附：原始数据

- 完整 commit 列表：`docs/diff-from-upstream-commits.md`（205 行）
- 完整文件级 diff stat：`docs/diff-from-upstream-files.md`（6169 行）

这两个文件可用以下命令重新生成：

```bash
git log v0.3.0..main --oneline > docs/diff-from-upstream-commits.md
git log v0.3.0..main --stat > docs/diff-from-upstream-files.md
```
