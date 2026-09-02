# RJ-laixue

> **AI 协作须知**：本文件由 AI 协作系统（Claude Code / WorkBuddy）自动读取，置于仓库根目录。
> 详细技术文档见 `docs/DEV.md`（开发视角）/ `docs/PRD.md`（产品视角）/ `docs/diff-from-upstream.md`（与上游差异）。

---

## 项目定位

RJ-laixue 是基于 **THU-MAIC/OpenMAIC v0.3.0** 的 fork（+205 自研 commit），服务锐捷大学培训部门。

- **上游**：OpenMAIC v0.3.0（一键生成多智能体交互课堂，MIT 协议）
- **fork 关键差异**：从单一 LLM 客户端调用 → **Supabase 三级 RBAC 平台**（admin/teacher/learner）
- **部署**：Vercel + Supabase（生产地址 https://www.laixue.work）

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Next.js 16（**必须 `--webpack`，禁用 Turbopack**——见下） + React 19 + Zustand + Motion |
| 后端 | Next.js API routes + server actions |
| 数据库 | Supabase Postgres + Auth |
| 文件存储 | Vercel ephemeral fs + Supabase Storage（**`/data` gitignore 掉**） |
| LLM | MiniMax M2.7（Anthropic 兼容端点 `https://api.minimaxi.com/anthropic/v1`） |
| TTS | MiniMax TTS（`TTS_MINIMAX_API_KEY`） |
| 持久化 | 客户端 Zustand → IndexedDB（`lib/utils/database.ts` schema） |

## 关键代码地图

### 必修（高耦合/易踩坑）

| 路径 | 作用 | 警告 |
|---|---|---|
| `supabase-*.sql` (9 个) | 数据库 schema 补丁 | 按固定顺序跑（见 `docs/DEV.md` §4） |
| `lib/store/stage.ts` | Zustand store（场景顺序 + 生成状态） | `scenes.sort` 不能无条件用 order；见 `stage.sceneOrderTrusted` |
| `lib/utils/database.ts` | IndexedDB schema（store 持久化） | 新字段要加进 db.version() 否则迁移不生效 |
| `lib/hooks/use-scene-generator.ts` | 主生成 hook | 含 PR1/2/3 改动（自动保存 + 进度 + 超时） |
| `lib/server/api-guard.ts` | 登录+角色+限速工具 | 所有 `/api/generate/*` 必须用它 |
| `lib/supabase/server.ts` | service_role client | **只能在 RSC / API route 用，绝不能 leak 到 client bundle** |
| `app/api/courses/[id]/route.ts` | 课程云端 API | 3 层权限校验（PR1 修过） |
| `app/m/[id]/page.tsx` + `lib/mobile/course-data.ts` | 移动端学习 | service_role 风险——见代码注释 |

### 锐捷定制（fork 新增）

| 路径 | 作用 |
|---|---|
| `app/admin/*` | 管理员界面（学员/老师/课件管理） |
| `app/api/admin/*` | 管理员 API |
| `app/api/access-code/redeem/route.ts` | 学员 6 位 access_code 登录 |
| `app/student/` | 学员首页 |
| `app/invite/` | 邀请页 |
| `docs/PRD.md` `docs/PRD-mobile.md` | 产品需求 |

## 开发规范

### 启动

```bash
pnpm install --ignore-scripts
pnpm dev --webpack     # ← 必须加 --webpack
```

**为什么禁用 Turbopack**：Turbopack 在 Windows + pnpm 虚拟路径 + shiki（OPENMAIC 上游高亮）会 panic（junction point 错误）。所有 dev/build 命令必须 `--webpack`。

### 关键坑（按出 bug 概率排序）

1. **Turbopack panic** → 改用 `--webpack`
2. **`createClient` vs `createBrowserClient`** → 必须用 `@supabase/ssr` 的 `createBrowserClient`，否则 session 存 localStorage，server RSC 读不到 cookie
3. **`router.replace` 不刷新 RSC** → 改用 `window.location.assign(path + '?_=' + Date.now())`
4. **Supabase `set_config()` 跨 PgBouncer 失效** → trigger 里的 admin email 必须硬编码到函数体
5. **改了 server import 没生效** → 删 `.next` + 重启 dev
6. **`sceneOrderTrusted` 字段白名单漏洞** → saveStageData 的字段白名单必须包含新加的 stage 字段（fb9a36b3 fix 教训）
7. **`/data` 目录** → Vercel ephemeral fs 重启会清；supabase-*.sql 不能假设 data 持久

### Git 提交

- Conventional commits（feat/fix/refactor/chore/docs/security）
- 中文 commit message 也可，但**标题用英文 / 中文都行**，正文说明用中文
- 一个 commit 一个原子改动；多 PR 用不同 commit
- `Co-Authored-By: Claude <noreply@anthropic.com>` 用于 AI 协作的 commit

## 架构原则

### 1. 服务端统一配模型，客户端零配置
所有 LLM/TTS key 在 Vercel env，**客户端看不到任何 key**。`/api/generate/*` 路由统一处理 model routing。

### 2. 数据库 schema 用 SQL 补丁文件管
9 个 `supabase-*.sql` 按顺序跑，每个 idempotent。**不要在生产直接改 schema**——先在本地迁移 → 写 SQL → Supabase Dashboard 跑。

### 3. Pro Mode / 编辑 / 播放用 URL 区分，不用 env flag
| URL | 用途 | Pro Mode toggle | 保存按钮 |
|---|---|---|---|
| `/classroom/[id]?editor=1` | 编辑（铅笔） | ✅ | ✅ |
| `/classroom/[id]` | 打开/分享/学员观看 | ❌ | ❌ |

`isMaicEditorEnabled()` **不再用**。`NEXT_PUBLIC_MIAC_EDITOR_ENABLED` env flag 删掉。

### 4. 数据流：生成完成 ≠ 云端可访问
- 生成完成 → 数据在客户端 IndexedDB + 服务端 `data/classrooms/{id}.json`
- **不会自动写 Supabase courses 表**——必须手动点"保存到云端"或等 PR1 的自动保存触发
- `data/` 是 gitignore + Vercel ephemeral → 重启即清空

### 5. RLS + API 鉴权双层防御
- 数据库 RLS 限定 row-level 访问
- API 路由独立鉴权（`requireAuthOrTeacher` + `rateLimitByUser`）
- 不要假设 RLS 单层够用——历史 bug 教训：`/api/courses/[id]` GET 端点之前完全无权限校验，任何登录用户能猜测 ID 拿到任意课程

## 不要做的事

1. ❌ **不要在客户端 import `@/lib/supabase/server`**（service_role key 会进 bundle）
2. ❌ **不要给 env flag 命名 `NEXT_PUBLIC_MIAC_EDITOR_ENABLED`**（已弃用）
3. ❌ **不要无条件 `scenes.sort((a, b) => a.order - b.order)`**（历史课程 order 不可信）
4. ❌ **不要在 Vercel `/data` 目录假设持久化**（ephemeral）
5. ❌ **不要绕过 `lib/server/api-guard.ts` 在 `/api/generate/*` 直接写路由**——会绕过登录/角色/限速
6. ❌ **不要把 9 个 `supabase-*.sql` 重写成单个 migration**——会破坏历史部署（必须保留顺序）
7. ❌ **不要给 `app/admin/*` 加新接口忘了在 `app/api/admin/*` 加对应的服务端**——admin UI 全部走 server 端鉴权

## 维护入口

- **生产地址**：https://www.laixue.work
- **Vercel Dashboard**：环境变量 + 部署历史
- **Supabase Dashboard**：SQL Editor 跑 schema / Table Editor 看数据 / Auth 看用户
- **GitHub**：https://github.com/zquanjin-wq/RJ-laixue
- **上游**：https://github.com/THU-MAIC/OpenMAIC（v0.3.0 是基准，v0.3.1 包含 SSRF 加固值得评估同步）

## 关键文档

- `docs/PRD.md` — 产品需求
- `docs/DEV.md` — 详细技术文档（DB 部署顺序 / env / 测试清单）
- `docs/diff-from-upstream.md` — 与 OpenMAIC v0.3.0 差异清单
- `docs/SECURITY-CHECKLIST-2026-07-23.md` — RLS 加固 + 接口防刷 + 分享页二次验证 记录
- `docs/AI-TEACHER-VOICE.md` — AI 教师音色（历史 bug 教训）
- `docs/RELEASE-NOTES-2026-07-21.md` — 之前 release notes
