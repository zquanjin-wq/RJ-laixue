# P0-B：Better Auth + PostgreSQL 验证报告

> 状态：通过  
> 日期：2026-09-01  
> 版本：Better Auth 1.7.2、PostgreSQL 18.4（本地临时实例）

## 1. 验证结论

Better Auth 可以作为 laixue 大陆版认证基础，当前没有发现需要改换 Auth.js 或自行实现认证的理由。

本次验证使用普通 PostgreSQL，不依赖 Supabase、PostgREST 或 RLS。Better Auth 默认创建四张表：

```text
user
session
account
verification
```

为了保持简单，正式设计采用 Better Auth 默认 public schema；laixue 业务表使用 app schema，RuntimeStore 使用 runtime schema。

## 2. 已通过流程

- Better Auth migration 可直接应用到普通 PostgreSQL。
- 创建首位管理员。
- 管理员使用邮箱密码登录。
- 管理员创建普通用户。
- 普通用户登录并读取 session。
- 管理员为用户设置新密码。
- 管理员禁用用户后，用户原 session 结束且不能继续登录。
- 管理员恢复用户后，用户可重新登录。
- 用户修改密码并结束其他 session。

实际运行结果：

```json
{
  "ok": true,
  "betterAuthTables": ["account", "session", "user", "verification"]
}
```

## 3. 对正式实现的影响

### 直接使用 Better Auth Admin 插件

账号管理所需的创建用户、设置密码、禁用、恢复和结束 session 已经具备，不需要再自行实现一套认证管理。

### 业务角色仍放在 `app.user_profiles`

Better Auth 只区分认证管理员与普通用户。laixue 的 admin、teacher、learner 继续由业务档案表达：

- Better Auth admin：允许执行账号管理。
- `app.user_profiles.role`：决定进入 laixue 后能做什么。

首位管理员同时具有两处 admin 标识，由一次性初始化命令创建。后续教师和学员由后台页面创建。

### 首次改密

Better Auth 已支持用户改密和结束其他 session。`must_change_password` 只需保存在 `app.user_profiles`，登录后发现该字段为 true 时引导用户完成一次改密，然后改为 false。不需要新增认证插件。

### 禁用账号

直接使用 Better Auth Admin 的禁用/恢复能力。业务档案不再重复保存另一套禁用状态，避免两处状态不一致。

因此，P0-A Schema 中 `app.user_profiles.status` 和 `disabled_at` 应在 P1 正式建表时删除；页面需要展示禁用状态时读取 Better Auth user 的状态。

## 4. 原型位置

原型位于：

```text
spikes/p0-b-better-auth/
```

运行命令：

```text
npm install --workspaces=false
npm run verify --workspaces=false
```

测试会在系统临时目录启动 PostgreSQL，结束后停止并清理数据。它不读取 `.env.local`，不连接生产环境。

## 5. 保持简单的实现决定

- 不启用组织、SSO、二次验证、公开注册等当前业务不需要的插件。
- 不为认证单独创建 PostgreSQL schema。
- 不自建密码或 session 实现。
- 不在 P0-B 改造现有登录页面；正式替换留在 P2 垂直切片。
- 测试只覆盖 laixue 当前明确需要的账号流程。

## 6. 下一步

P0-C：验证 COS 私有桶的上传、临时读取和音频播放所需能力。若暂时还没有 COS 凭据，也可以先进入 P1-A，生成本地 PostgreSQL 正式 migrations 与数据库连接层。

