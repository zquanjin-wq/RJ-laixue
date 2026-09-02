# Supabase 完整 Schema 导出指南

> **背景**：当前 RJ-laixue 数据库 schema 散落在 9 个 `supabase-*.sql` 文件里，按时间分批打的补丁。新接手的开发者（包括 AI）很难拼出"现在的真实 schema 是什么"。
>
> **解决方案**：从 Supabase **直接导出当前生产/预览环境的完整 schema**，作为 source of truth。

---

## ⚠️ 安全提醒

- **导出会包含表结构、视图、函数、RLS 策略、trigger 定义**——不含数据
- **不要把 `supabase/.temp` 这种临时目录 commit**——可能含连接信息
- **导出文件可以 commit**（schema 本身是公开信息），但**不要把 service_role key 加进 git**

---

## 步骤 1：装 supabase CLI（一次性）

```bash
# macOS
brew install supabase/tap/supabase

# Windows (Scoop)
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase

# 其他平台见 https://github.com/supabase/cli#install-the-cli
```

## 步骤 2：登录 + link 项目

```bash
cd "D:\WorkBuddy 地界\RJ-laixue"

# 登录（会跳浏览器）
supabase login

# Link 到你的 RJ-laixue 项目
# → 在 Supabase Dashboard → Project Settings → General 找 Project Reference ID
supabase link --project-ref <你的-project-ref>
```

## 步骤 3：导出完整 schema

```bash
# 导出 schema（不含数据），输出到标准位置
supabase db dump --schema public --file supabase-schema-snapshot.sql

# 同时导出角色/权限信息（推荐）
supabase db dump --schema public --role-only --file supabase-roles-snapshot.sql
```

> **提示**：如果你只有 anon key（没用 service_role），上面的命令需要 `supabase` 用户密码。从 Supabase Dashboard → Project Settings → Database → Connection string → URI 拿 `postgresql://postgres:[YOUR-PASSWORD]@db.xxx.supabase.co:5432/postgres`。

## 步骤 4：把 snapshot 文件 commit

```bash
git add supabase-schema-snapshot.sql supabase-roles-snapshot.sql
git commit -m "chore: 导出 Supabase 当前完整 schema 作为 source of truth

之前 9 个 supabase-*.sql 散落，AI 协作时拼不出当前真实 schema。
现在 supabase-schema-snapshot.sql 是 production-equivalent 的 schema dump。

后续修改 schema 时：
1. 先在本地 supabase db reset 测试
2. 改 supabase-schema-snapshot.sql 同步更新
3. Supabase Dashboard 跑新 migration
4. 重新 dump 一份覆盖

Co-Authored-By: Claude <noreply@anthropic.com>"
```

## 步骤 5：维护 workflow

之后改 schema 走这个流程：

| 步骤 | 谁 | 工具 | 产出 |
|---|---|---|---|
| 1. 改 schema | 开发者 | Supabase Dashboard SQL Editor | 在线 DB 已更新 |
| 2. 测试 | 开发者 | dev 环境 | 验证通过 |
| 3. 写 migration SQL | 开发者 | 新文件 `supabase-*.sql` | 增量 migration |
| 4. 跑 SQL 补丁 | 开发者 / DBA | Supabase Dashboard | 生产 DB 更新 |
| 5. 重新 dump | 开发者（自动化最好） | `supabase db dump` | 覆盖 `supabase-schema-snapshot.sql` |
| 6. 更新文档 | 开发者 | 编辑 `docs/diff-from-upstream.md` 等 | 新改动有据可查 |

## 推荐：自动化 dump

> ✅ **已就绪**：`.github/workflows/supabase-schema-snapshot.yml` 已创建。  
> 配 3 个 GitHub Secret 后即生效（详见 workflow 顶部注释）。

可以在 GitHub Actions 每周自动 dump 一次（`.github/workflows/schema-snapshot.yml`）：

```yaml
name: Weekly Supabase Schema Snapshot
on:
  schedule:
    - cron: '0 0 * * 0'  # 每周日 0 点
  workflow_dispatch:

jobs:
  snapshot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - name: Dump schema
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
          SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
        run: |
          supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_REF }}
          supabase db dump --schema public --file supabase-schema-snapshot.sql
      - uses: peter-evans/create-pull-request@v6
        with:
          commit-message: "chore: 定期更新 Supabase schema snapshot"
          title: "chore: 定期更新 Supabase schema snapshot"
          branch: chore/schema-snapshot
```

需要在 GitHub repo 配 3 个 secret：
- `SUPABASE_ACCESS_TOKEN`（从 https://supabase.com/dashboard/account/tokens 拿）
- `SUPABASE_DB_PASSWORD`（项目数据库密码）
- `SUPABASE_PROJECT_REF`（项目 ref ID）
