# laixue：AIDAP Supabase 迁移资产基线

**采集时间：** 2026-08-15  
**来源：** 现有 Supabase 生产项目（只读盘点）  
**用途：** AIDAP 测试迁移与生产切换后的完整性验收基线。

## 1. 当前实例概况

| 项目 | 当前值 |
| --- | --- |
| 实例地域 | Northeast Asia (Tokyo) |
| 实例规格 | Free / nano |
| 实例状态 | Healthy |
| 数据库磁盘使用率 | 约 15% |
| 自动备份 | 未配置 |
| 分支 | 未创建 |

## 2. 必须迁移的 Supabase 能力

| 能力 | 现状 | 迁移要求 |
| --- | --- | --- |
| Auth | 32 个用户 | 保留用户 ID、邮箱、密码哈希、账号状态和角色关联 |
| 数据库 | 课程、师生、学习任务、进度与事件数据 | 保留 schema、索引、约束、触发器、RLS 和数据 |
| Storage | 2 个公开桶 | 保留文件路径、对象内容、MIME 类型和公开访问行为 |
| REST API | 应用通过 Supabase JS SDK 调用 | 在 AIDAP 测试环境验证现有 SDK 配置可用 |

## 3. Storage 桶

| 桶名 | 公开访问 | 用途 |
| --- | --- | --- |
| `course-audio` | 是 | 课堂/课程音频 |
| `course-assets` | 是 | PDF、课程素材、生成资产 |

> 桶与文件数量、字节数需在 AIDAP 测试导入后做对象级校验；不在文档记录文件内容或用户数据。

## 4. 核心表记录基线

| 表 | 行数 |
| --- | ---: |
| `profiles` | 32 |
| `students` | 32 |
| `courses` | 17 |
| `course_assignments` | 0 |
| `course_progress_events` | 36 |
| `learning_tasks` | 5 |
| `task_courses` | 7 |
| `task_learners` | 29 |
| `task_course_progress` | 39 |
| `task_learning_events` | 602 |
| `course_snapshots` | 5 |
| `course_revoice_jobs` | 18 |
| `ai_learning_summaries` | 0 |
| `ai_intervention_suggestions` | 0 |

## 5. 代码依赖结论

- 应用使用 Supabase Auth，包括会话、账号创建、禁用、密码重置及管理员用户查询。
- 应用以 service role 执行后台读写，并依赖 `profiles` 的角色判断。
- 应用使用公开 Storage URL 上传和读取课程音频、课程资产与 PDF。
- 未发现业务依赖 Supabase Edge Functions；本次重点是 PostgreSQL、Auth、Storage 和 RLS 兼容性。

## 6. 下一关：测试工作区

在 AIDAP 创建 **Supabase 引擎测试 Workspace** 后，迁入副本并逐项验收：

1. 数据库 schema、触发器、RLS 与表行数。
2. Auth 用户登录和管理员操作。
3. 两个 Storage 桶的对象与公开 URL。
4. laixue 的登录、PDF 上传解析、课程生成、课程读取与保存。

测试验证通过前，不修改 Dokploy 的生产 Supabase 环境变量，也不切换正式数据源。
