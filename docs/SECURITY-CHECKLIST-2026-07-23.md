# RJ-laixue 安全加固检查清单

> 日期：2026-07-23  
> 范围：基于 Supabase Auth + RLS + 接口防刷的整体安全加固

---

## ✅ 已完成（2026-07-23 这一轮）

### 1. RLS 策略
- `supabase-rls-tighten-wave1.sql` 已应用：撤销 anon 对 students / course_assignments / course_progress_events 的写入权限
- `supabase-rls-tighten-wave2.sql` 已应用：courses 表启用 RLS，限 anon/authenticated SELECT-only
- `supabase-rls-tighten-wave5.sql` 已应用：撤销全部 anon SELECT（所有读写走 /api/* 路由 + service_role）
- `supabase-rls-tighten-courses-owner.sql` （本轮新增）：
  - 收紧 course_assignments SELECT：学员只能读自己被分配的；teacher/admin 可读全部
  - 防御性地再次 drop 任何残留 anon 策略
  - 提供 dirty created_by 行回填指引

### 2. AI 生成接口防刷
新增 `lib/server/api-guard.ts`，为以下路由加 **登录 + 角色 + 频率限制**：

| 路由 | 限速策略 | 角色 |
|---|---|---|
| `/api/generate-classroom` | 5/60s | teacher / admin |
| `/api/generate/scene-outlines-stream` | 15/30s | teacher / admin |
| `/api/generate/scene-content` | 15/30s | teacher / admin |
| `/api/generate/scene-actions` | 15/30s | teacher / admin |
| `/api/generate/agent-profiles` | 15/30s | teacher / admin |
| `/api/generate/image` | 5/30s | teacher / admin |
| `/api/generate/video` | 3/60s | teacher / admin |
| `/api/generate/tts` | 30/60s | teacher / admin |
| `/api/generate/voice` | 10/60s | teacher / admin |

限速基于内存 Map + 用户 ID（Vercel 单实例 best-effort，多实例需升级 Redis）。

### 3. 分享页二次验证
修复 `/api/courses/[id]` GET 端点（之前完全无权限校验，任何登录用户猜测 ID 就能拿到完整课程）：

- 必须登录（401）
- teacher 看自己创建的 OR 全部（catalog 浏览）
- admin 看全部
- learner 必须有 course_assignments 行指向 student.user_id = 自己

### 4. 敏感信息扫描
- `lib/supabase/server.ts:77` — service_role 在服务端 ✅
- `lib/server/classroom-media-generation.ts:89` — service_role 在服务端 ✅
- `app/api/audio-upload/route.ts:78` — service_role 在服务端 ✅
- `lib/mobile/course-data.ts:72` — **隐患已加防御性注释**（实际安全，但脆弱——见下）

### 5. API 错误码扩展
新增到 `lib/server/api-response.ts`：
- `UNAUTHENTICATED`
- `FORBIDDEN`
- `PROFILE_LOOKUP_FAILED`
- `SERVER_MISCONFIG`

---

## ⚠️ 已知隐患（需关注）

### 隐患 1：`lib/mobile/course-data.ts` 的 service_role 风险
该文件在 server component 中直接用 `SUPABASE_SERVICE_ROLE_KEY` 查询课程。如果未来有人在 mobile 学习流程里加 'use client' 或者客户端组件 import 此文件，service_role key 会泄漏到浏览器 bundle。

**已加注释警告**。长期方案：把所有 mobile 数据访问改成走 `/api/courses/[id]`（已经做了权限校验）。

### 隐患 2：脏 `created_by` 数据
历史课程 `created_by = NULL`，当前 `/api/courses/[id]` GET 允许 teacher/admin 读取这些行（注释里说明了原因）。**需要在 Supabase SQL Editor 跑 0b 查询找出所有脏行，并人工回填**。

### 隐患 3：Vercel 多实例限速失效
`rateLimitByUser` 用进程内 Map，Vercel 多实例不共享——攻击者撞到不同实例可绕过 1 倍配额。
- 短期：可接受（best-effort）
- 长期：升级 Redis（Upstash Redis 已可在 Vercel 上用）

### 隐患 4：`/api/courses/route.ts` POST 的 created_by 强制
任务 1 第三步要求 "找到代码中写入 courses 表的地方，确保插入时 created_by = supabase.auth.getUser().id"。需要单独 review 该路由，确认已正确设置。

---

## 📋 待用户执行的 SQL

去 Supabase SQL Editor 跑 `supabase-rls-tighten-courses-owner.sql`：

1. 先跑 0a / 0b / 0c 看现状（read-only）
2. 跑 2 段（收紧 course_assignments SELECT）
3. 跑 4 段验证
4. （可选）3 段修复脏 created_by

---

## 📋 后续防御性工作（不在本轮范围）

| # | 工作 | 优先级 |
|---|---|---|
| 1 | 给所有 `/api/learning/*` 加同样 guard（learner 也算高敏感） | 高 |
| 2 | `/api/courses/route.ts` POST 路径核查 created_by | 高 |
| 3 | 升级限速到 Redis（Upstash） | 中 |
| 4 | 给 admin 操作加 audit log（who did what when） | 中 |
| 5 | 引入 Sentry 监控异常登录 + 异常流量 | 中 |
| 6 | 给所有错误响应统一加上 `requestId` 便于追踪 | 低 |
