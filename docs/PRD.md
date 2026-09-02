# RJ-laixue · 产品需求文档 (PRD)

**Owner**: 锐捷大学培训部门  
**Contact**: jinzengquan@ruijie.com.cn  
**Status**: MVP 内部试用阶段 — 功能接近完整，仍在 RLS 收紧收尾

---

## 1. 业务背景

锐捷大学是锐捷内部的企业培训部门。员工需要接受**统一的内部培训**（入职、产品、合规、技术栈等），课程由培训部门统一生产，**不能**让员工自选第三方模型或自购 API。

OPENMAIC v0.3.0 是 THU-MAIC 团队的开源 AI 课件生成工具，设计是"每个用户自己配 LLM key 自己用"——**不符合**锐捷大学的封闭用户群 + 集中模型管控需求。

**RJ-laixue** 是基于 OPENMAIC v0.3.0 的私有 fork，针对锐捷大学场景做定制。

---

## 2. 核心定制（区别于 OPENMAIC 上游）

| # | 定制点 | 上游默认 | RJ-laixue |
|---|---|---|---|
| 1 | 模型配置 | 用户自配 / 客户端配 | **服务端统一配**（admin 在 `.env.local` / Vercel env 配 MiniMax key） |
| 2 | 账号体系 | 匿名 / 本地 | **admin 创建 + 学员账号**（封闭用户群，无自助注册） |
| 3 | 角色 | 单角色 | **admin / teacher / learner** 三角色 |
| 4 | 模型供应商 | OpenAI / Anthropic 直连 | **MiniMax**（`https://api.minimaxi.com/anthropic/v1`，Anthropic 兼容） |
| 5 | 课程分享 | 匿名 + access_code 链接 | **admin / 老师把云端课件直接发给学员账号**，学员登录观看 |
| 6 | 课程分配 | 老师手动指定学员 | **所有 active 学员看所有云端课件**（无分配） |
| 7 | Pro Mode 编辑 | 默认关闭 | **URL 驱动**（`?editor=1` 触发，跟 env flag 无关） |
| 8 | TTS | 用户自配 | **服务端统一配** `TTS_MINIMAX_API_KEY` |

---

## 3. 用户角色

### admin（**只有 jinzengquan@ruijie.com.cn**）
- 管学员账号 + 管老师账号
- 创建 / 重置密码 / 禁用 / 删除学员和老师
- 创建 + 编辑 + 保存云端课件（走 OPENMAIC 创作首页 `/`）
- 预览所有学员能看到的课件
- 进 `/admin/*` 后台

### teacher（**admin 创建**）
- 创建 + 编辑 + 保存云端课件（首页 `/`）
- 不能进 `/admin/students`（账号管理）
- 不能进 `/admin/teachers`（其他老师管理）
- 看不到 admin 后台

### learner（**admin 创建**）
- 登录后进 `/student/courses` 看到所有 active 云端课件
- 点进 `/classroom/[id]` 纯观看（**无 Pro Mode toggle + 无保存按钮**）
- 账号被禁用时显示"账号已停用"卡片

---

## 4. 核心流程

### 4.1 admin 创建学员
```
admin → /admin/students → 顶部"创建新学员"表单 → 输姓名+邮箱 → 创建
→ 服务端用 service_role 一并创建 auth.users + students 行
→ 自动生成 12 位初始密码 → admin 抄下口头告诉学员
```

### 4.2 学员登录观看
```
学员用 email + 初始密码登录 → 跳 /student/courses
→ 列出所有 active 课件（每条从 public.courses 直接读，不走 course_assignments）
→ 点进 /classroom/[id]（纯观看，无 Pro Mode toggle，无保存按钮）
```

### 4.3 admin / 老师创建课件
```
admin 或 teacher 登录 → 首页 / 进入 OPENMAIC 创作工具栏
→ 输主题 → 等生成 → 点"保存到云端"
→ 写到 public.courses + public.students(由 supabase-learning-mvp.sql 处理)
→ 学员进 /student/courses 自动看到新课件
```

### 4.4 admin / 老师编辑课件（Pro Mode）
```
admin 或 teacher 鼠标悬停 / 课程卡片 → 右上角点铅笔
→ /classroom/[id]?editor=1
→ 自动进 Pro Mode (mode='edit') + 显示 Pro Mode toggle + 显示保存按钮
→ 编辑 → 保存 → 同步到云端
```

### 4.5 admin 分享课件
```
admin 在 / 创作工具栏 → 鼠标悬停保存的课程 → "分享"按钮
→ 复制 /classroom/{id}（无 query）链接
→ admin 把链接发给学员（口头 / 飞书 / 邮件）
→ 学员用账号访问 → 纯观看
```

---

## 5. 已完成功能

| 功能 | 状态 |
|---|---|
| 账号体系：admin / teacher / learner 三角色 + disabled_at 软删除 | ✅ |
| admin 后台 `/admin` hub（4 cards：学员 / 老师 / 课件 / 运营报表） | ✅ |
| 学员管理 `/admin/students`（创建 / 重置密码 / 禁用 / 启用） | ✅ |
| 老师管理 `/admin/teachers`（创建 / 重置密码 / 禁用 / 启用） | ✅ |
| 学员首页 `/student/courses`（显示所有云端课件 + 进入教室） | ✅ |
| 课件管理 `/admin/courses`（列出已发布课件 + 进入只读教室） | ✅ |
| 删除学员档案（删 auth.users + students 行） | ✅ |
| 邀请页 `/invite`（**已废弃**，保留以兼容老数据） | 🟡 残留 |
| 服务端统一模型（MiniMax LLM + MiniMax TTS） | ✅ |
| 登录 / 登出流程 | ✅ |
| Pro Mode 编辑（`?editor=1` URL 触发） | ✅ |
| 课程"打开 / 分享 / 编辑" 三个入口完全分离 | ✅ |

## 6. 已知问题 / 限制

| 项 | 说明 | 处理 |
|---|---|---|
| Supabase dashboard RLS: anon 仍能读所有学习表 | OPENMAIC 上游创作流程的 anon API 还需要 anon 读 | Wave 5 (RLS 收紧最后一波) |
| 飞书 SSO / 飞书账号体系对接 | 培训部门计划接入飞书作为统一账号体系 | 后续阶段（不在 MVP） |
| 课件分配 | 当前**所有 active 学员看所有云端课件**（不按学员分配）。如果以后需要"指定学员可见"可扩展 `course_assignments` 表（已存在 schema 但未使用） | 待需求 |
| 运营报表 | 学员学习完成度、课程活跃度等。admin hub 有占位 card，未实现 | 后续阶段 |
| ACCESS_CODE HMAC 校验 | OPENMAIC 上游的 ACCESS_CODE HMAC 校验（环境变量）仍存在，跟我们的 Supabase Auth 并存 | 保留兼容 |

## 7. 后续阶段（按优先级排）

1. **RLS 收紧 第 2-5 波**（改动 OPENMAIC 上游 anon API → service_role，最后撤 anon SELECT）— **当前正在做**
2. **课件分配**（如果业务需要）
3. **运营报表**（admin 后台）
4. **飞书账号体系对接**（替换邮箱登录为飞书登录）
5. **OpenMAIC 上游代码跟进**（上游更新时同步 RJ-laixue 定制）

---

## 8. 部署

- **域名**: https://www.laixue.work
- **托管**: Vercel（自动从 GitHub `zquanjin-wq/RJ-laixue` main 分支部署）
- **数据库**: Supabase（project ref: aqmktsagfvkikehynpdw）
- **本地 dev**: `pnpm dev --webpack`（必须用 webpack，不能用 Turbopack——Windows 上 shiki + pnpm 虚拟路径 + Turbopack 会 panic）
- **生产 schema 部署**: 跑 `supabase-auth-mvp.sql` + `supabase-auth-triggers.sql` + `supabase-students-disabled.sql` + `supabase-rls-tighten-wave1.sql`（必须**按顺序**跑，且 idempotent 可重跑）

---

## 9. 关键决策记录

| 日期 | 决策 | 原因 |
|---|---|---|
| 2026-07-11 | **去掉 self-registration**（login page 删注册 tab） | 用户没研发经验 + 企业封闭用户群，无自助注册场景 |
| 2026-07-11 | **admin 后台用 service_role** 写 Supabase | anon key 公开不安全；service_role 只能在服务端跑，可信 |
| 2026-07-11 | **取消 course_assignments 分配**（所有 active 学员看所有 active 课件） | 用户当前业务简单，不需要按人分配 |
| 2026-07-12 | **Pro Mode 完全 URL 驱动**（不用 env flag） | env flag 全局污染；URL 区分"打开/分享/编辑"三个入口更清晰 |
| 2026-07-12 | **access_code 字段保留**但不显示 | 历史数据兼容；表 schema 默认值仍生成 |
| 2026-07-12 | **learning-manager 组件保留**但不引用 | OPENMAIC 上游别处仍 import；RJ-laixue 不再路由到它 |
| 2026-07-12 | **所有 admin 表单关闭按钮用 `window.location.assign('/admin/students?_=' + Date.now())`** 强制全页跳转 + cache-busting | Next.js 16 dev mode `router.refresh()` 不刷新 RSC payload；hard nav + cache-busting 是最稳 |

---

## 10. 联系与交接

- **当前 owner**: jinzengquan@ruijie.com.cn（也是 platform admin，**唯一**）
- **handoff 文档**: `docs/DEV.md`（开发细节）+ `README.md`（开发者入门）
- **其他代理接手**: 任何 LLM 代理读完 `docs/PRD.md` + `docs/DEV.md` + `git log --oneline` 能继续推进