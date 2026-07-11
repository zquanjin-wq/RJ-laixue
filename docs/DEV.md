# RJ-laixue · 开发文档

**配合**: `PRD.md`（产品视角）。**本文件**：技术视角。

---

## 1. 工程结构

RJ-laixue 基于 OPENMAIC v0.3.0 的 fork。**重要**：所有 OPENMAIC 上游目录（`app/`、`components/`、`lib/`、`packages/`）里的文件，**只要在 RJ-laixue 仓库里我们就可以改**——这不"动 OPENMAIC 上游"，而是动 RJ-laixue 这个 fork 项目。

### 我们改过的目录

| 目录 | 性质 | 说明 |
|---|---|---|
| `app/admin/` | **RJ-laixue 新增** | admin hub + 学员/老师/课件管理 |
| `app/api/admin/` | **RJ-laixue 新增** | admin 后台 API（create / disable / enable / reset-password / unbind / delete） |
| `app/invite/` | **RJ-laixue 改造** | 原本 access_code redemption；保留兼容但不再走主流程 |
| `app/student/` | **RJ-laixue 新增** | 学员首页 |
| `lib/supabase/` | **RJ-laixue 新增** | server / client / service-role 三种 supabase client |
| `lib/auth/` | **RJ-laixue 新增** | use-auth hook（client 端 auth state） |
| `supabase-*.sql` | **RJ-laixue 新增** | schema patch 文件（必须按顺序跑） |
| `docs/PRD.md`、`docs/DEV.md` | **RJ-laixue 新增** | 交接文档 |
| `app/api/access-codes/` | **RJ-laixue 新增** | access_code 兑换 API（保留兼容） |

### 我们改过的 OPENMAIC 上游文件（fork 后可以改）

| 文件 | 改了什么 |
|---|---|
| `components/auth-gate.tsx` | 让 teacher role 也能通过 AdminGate（admin + teacher 都可进首页创作页） |
| `components/cloud-courses.tsx` | 删分享 + 学习管理按钮、加"打开 / 分享"按钮、加 Pro Mode URL 驱动 |
| `components/stage.tsx` | Pro Mode toggle 完全 URL-driven（`?editor=1`） |
| `components/edit/EditChromeRoot.tsx` | 同上 |
| `app/page.tsx` | pencil 按钮 `onClick` 从"重命名课程标题"改成"进 `/classroom/[id]?editor=1` Pro Mode" |
| `app/classroom/[id]/page.tsx` | 加 `?editor=1` URL handler → 直接进 Pro Mode；"保存到云端"按钮只在 `?editor=1` 时显示 |
| `app/login/page.tsx` | 删注册 tab（账号由 admin 创建，无自助注册） |
| `app/api/courses/*` | **待改**（RLS Wave 2/3 时改 anon → service_role） |

---

## 2. 关键技术决策

### 2.1 Next.js 16 必须用 webpack，不能用 Turbopack

**坑**：Turbopack 在 Windows + pnpm 虚拟路径 + shiki（OPENMAIC 上游代码高亮）会 panic：`failed to create junction point to .../node_modules/.pnpm/shiki@...`

**解决**：所有 dev / build 命令加 `--webpack`：
```bash
pnpm dev --webpack
```

### 2.2 `lib/supabase/client.ts` 必须用 `createBrowserClient`（@supabase/ssr），不能用 `createClient`

**坑**：默认 `createClient` 把 session 存 `localStorage`，server-side RSC 读 cookie 拿不到 → "登录成功但 RSC 看不到 session" 死循环。

**修复**：用 `@supabase/ssr` 的 `createBrowserClient`，把 session 写到 cookie。

### 2.3 Login 后用 `window.location.assign(next)` 强制全页跳转，不用 `router.replace(next)`

**坑**：`router.replace` + `router.refresh` 在 Next.js 16 dev mode 不刷新 RSC payload，会返回缓存的旧数据。

**修复**：`window.location.assign(next)` 强制浏览器全页 GET，server RSC 重新跑。

### 2.4 Admin 表单关闭按钮用 `window.location.assign('/admin/students?_=' + Date.now())`

**坑**：Next.js client router 会拦截 `window.location.assign('/admin/students')`，仍返回缓存的旧 RSC payload。

**修复**：加 `?_=<timestamp>` cache-busting 参数，让 Next.js 视为新 URL 重新查。

### 2.5 Pro Mode / 编辑 / 播放用 URL 区分，不用 env flag

| URL | 用途 | Pro Mode toggle | 保存按钮 |
|---|---|---|---|
| `/classroom/[id]?editor=1` | 编辑入口（铅笔） | ✅ | ✅ |
| `/classroom/[id]` | 打开/分享/学员观看入口 | ❌ | ❌ |

**坑**：之前用 `NEXT_PUBLIC_MIAC_EDITOR_ENABLED` env flag gate → 一次设了之后所有 `/classroom/[id]` 都显示 Pro Mode toggle → "打开" 也能编辑，违背"学员不可编辑"原则。

**修复**：gate 改成纯 URL 驱动。`isMaicEditorEnabled()` 完全不用。env flag 可以从 `.env.local` 删掉。

### 2.6 Supabase Postgres `set_config()` 跨 PgBouncer 失效

**坑**：`upgrade_seed_admin` trigger 原本用 `set_config('app.seed_admin_email', ...)` 配 admin email，trigger 期望 `current_setting('app.seed_admin_email')` 读到。Supabase 用 PgBouncer connection pool，trigger 在新 connection 跑，看不到前一个 connection 的 GUC → admin email 永远是 NULL → trigger 不命中。

**修复**：把 email 硬编码到 trigger 函数体里：`if lower(coalesce(new.email, '')) = lower('jinzengquan@ruijie.com.cn') then ...`。

### 2.7 `.next` 缓存问题

**坑**：改了 server-side import 后，webpack dev 有时不重编译，user 看到旧行为。

**修复**：删 `.next` 目录 + 重启 `pnpm dev --webpack`（每次大改 schema 或路由结构后）。

---

## 3. 环境变量（`.env.local` 必填项）

```bash
# Supabase（公开 + service_role 两套）
NEXT_PUBLIC_SUPABASE_URL=https://aqmktsagfvkikehynpdw.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_9ElsG6pY5s4jFiXEBhS-vQ_TQMjuGfW
SUPABASE_URL=https://aqmktsagfvkikehynpdw.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_Pz9L6c-2_WvzcxtaeXkTmQ_bMhXqank

# TTS（服务端统一配的 MiniMax TTS）
TTS_MINIMAX_API_KEY=sk-cp-...你的 TTS API key...

# LLM（服务端统一配的 MiniMax M2.7 Anthropic 兼容）
MINIMAX_API_KEY=sk-cp-...你的 LLM API key...
MINIMAX_BASE_URL=https://api.minimaxi.com/anthropic/v1
MINIMAX_MODELS=MiniMax-M2.7
DEFAULT_MODEL=minimax:MiniMax-M2.7
```

**不要**再加 `NEXT_PUBLIC_MIAC_EDITOR_ENABLED`（代码不读了）。**不要**改 `ACCESS_CODE`（OPENMAIC 上游 HMAC 流程，跟我们无关）。

Vercel Dashboard 同步配同样的 6 个 env。

---

## 4. 数据库 schema 部署顺序

按以下顺序在 Supabase Dashboard → SQL Editor 跑：

1. `supabase-learning-mvp.sql`（OPENMAIC 上游 mvp schema）—— 必须
2. `supabase-auth-mvp.sql`（RJ-laixue profiles 表 + handle_new_user trigger）—— 必须
3. `supabase-auth-triggers.sql`（handle_new_user + upgrade_seed_admin triggers）—— 必须
4. `supabase-students-disabled.sql`（students.disabled_at 软删除列）—— 必须
5. `supabase-rls-tighten-wave1.sql`（RLS 第 1 波：撤 anon 写入）—— 推荐（生产部署前必跑）

**所有 SQL 都是 idempotent（可重跑）**。

---

## 5. 本地开发

```bash
# 第 1 步：安装依赖
cd "D:\WorkBuddy 地界\RJ-laixue"
pnpm install --ignore-scripts  # ignore-scripts 避免 workspace build 占时间

# 第 2 步：跑 schema（如果新 clone 仓库）
# 跑上述 5 个 SQL（按顺序）

# 第 3 步：配 .env.local
# （把上面的环境变量填进 .env.local）

# 第 4 步：启动 dev
pnpm dev --webpack

# 浏览器访问 http://localhost:3000
```

---

## 6. 部署

- 推 GitHub → Vercel 自动部署
- Vercel 项目 env 配置跟 `.env.local` 一致（生产环境变量）
- Supabase 服务端 schema 部署：`supabase-*.sql` 在 SQL Editor 跑

---

## 7. 测试路径（核心流程验证清单）

按顺序走一遍：

| # | 操作 | 期望 |
|---|---|---|
| 1 | 浏览器访问 http://localhost:3000 | 跳 `/login` |
| 2 | 用 jinzengquan@ruijie.com.cn + admin 密码登录 | 跳 `/`（OPENMAIC 创作首页） |
| 3 | 顶部 admin hub 显示 4 cards | 学员 / 老师 / 课件 / 运营报表 |
| 4 | 进 `/admin/students` → 创建新学员 `zhangsan@ruijie.com.cn` | 绿色卡片显示初始密码 → 确认后跳回列表看到 zhangsan |
| 5 | 进 `/admin/teachers` → 创建老师 `teacher.li@ruijie.com.cn` | 绿色卡片 + 初始密码 + 列表能看到 |
| 6 | 用 zhangsan 登录（无痕窗口） | 跳 `/student/courses`（默认 0 个课件） |
| 7 | admin 用 OPENMAIC 创作工具生成 + 保存课件到云端 | 课件在 `/admin/courses` 列表 |
| 8 | zhangsan 刷新 `/student/courses` | 看到新课件 |
| 9 | 点进 `/classroom/[id]` | 纯播放，无 Pro Mode toggle，无保存按钮 |
| 10 | admin 回 `/` 创作页 → 悬停保存的课程 → 点铅笔 | 新 tab `/classroom/[id]?editor=1`，**有** Pro Mode + 保存按钮 |
| 11 | admin 回 `/admin/students` → 点 zhangsan 行的"禁用账号" → 输 `zhangsan` 确认 | zhangsan 变 `已禁用` |
| 12 | zhangsan 刷新 | 显示"账号已停用"卡片 |
| 13 | admin 启用 zhangsan | 恢复 `已启用` |

---

## 8. 调试技巧

| 问题 | 排查 |
|---|---|
| dev 报 JSX 错误 | 看 build error 信息 + 对应文件位置；常见原因是 hook 在 JSX 内或缩进错（hook 当成模块顶层） |
| 路由 404 | 看 Next.js dev log 输出；检查 `app/api/xxx/[id]/route.ts` 路径结构跟 URL 是否对得上 |
| Supabase 静默返回空数据 | 用 `service_role` 手动 `select * from <table> limit 1`；如果 42703（列不存在）→ schema 缺列；RLS 拒绝 → 列存在但权限不够 |
| RSC 不刷新 | 给 client 按钮改 `window.location.assign('/path?_=' + Date.now())`（cache-busting） |
| Pro Mode 不显示 | 看 stage.tsx 和 EditChromeRoot.tsx 的 `toggleHandler` 是不是 `editorAutoOpen ? ... : undefined`（纯 URL） |
| Turbopack panic | 改用 `pnpm dev --webpack` |
| GitHub push 失败 | 国内连 GitHub 不稳；用 GitHub Desktop 客户端走代理；或等网络好 |

---

## 9. 接手清单（其他代理 / IT 接手）

1. 读 `docs/PRD.md` + `docs/DEV.md`
2. 读 `git log --oneline -30` 看历史
3. 跑 schema 5 个 SQL（在 Supabase Dashboard）
4. 配 `.env.local`（按本文档第 3 节）
5. `pnpm install --ignore-scripts && pnpm dev --webpack`
6. 走一遍"测试路径"清单
7. **RLS 收紧第 2-5 波**（如果还没完成）—— 见 `supabase-rls-tighten-wave1.sql` 注释里列出的 wave 2/3/4/5

---

## 10. 联系

- 当前 owner: jinzengquan@ruijie.com.cn
- 工具链: pnpm + Next.js 16 (webpack) + Supabase + Vercel