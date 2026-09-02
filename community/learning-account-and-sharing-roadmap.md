# 课程分享、学员账号与学习追踪设计草案

## 背景

RJ-laixue 目前更偏向“老师生成课程、自己预览/播放”的工作流。下一阶段的真实业务需求是：课程生成后可以分发给学员学习，老师能看到谁已学习、谁未学习，以及基础学习完成情况。

这意味着系统需要从“课程生成工具”扩展为一个轻量学习系统，至少包含账号、课程发布、学员访问、学习记录和老师看板。

## 目标

- 老师可以把已生成课程发布给指定学员或学员组。
- 学员使用账号登录后，可以看到分配给自己的课程。
- 学员进入课程学习时，系统记录学习状态。
- 老师可以查看课程维度的学习名单：已学、未学、学习中。
- 老师可以查看学员维度的学习记录：被分配课程、完成状态、最近学习时间。

## 非目标

- 第一版不做复杂 LMS 能力，例如考试成绩体系、证书、学分、班级运营、消息通知、组织架构同步。
- 第一版不做复杂权限矩阵，只区分老师、管理员、学员即可。
- 第一版不强依赖企业微信、飞书、LDAP、SSO，除非后续确认公司内部集成优先级更高。

## 推荐分期

### V1：最小可用学习闭环

目标是尽快让老师能“发课、看谁学了”。

功能范围：

- 登录账号：老师、学员两类角色。
- 学员管理：老师或管理员可以创建学员账号，支持批量导入姓名、邮箱或工号。
- 课程发布：老师把生成好的课程发布为一个学习任务。
- 课程分配：按学员选择分配课程。
- 学员首页：展示“我需要学习的课程”。
- 学习记录：进入课程记为 `started`，播放或浏览到最后一页记为 `completed`。
- 老师看板：按课程查看 `assigned`、`started`、`completed`、`not_started`。

建议工期：

- 1 名全栈开发：约 7-12 个工作日。
- 如果已有 Supabase 云存储完全可用：约 5-8 个工作日。
- 如果还要补 Supabase 表、RLS、登录态、部署联调：约 10-15 个工作日。

### V2：管理体验增强

目标是减少老师运营成本。

功能范围：

- 学员分组或班级。
- 批量分配课程。
- 学习截止时间。
- 老师导出学习明细 CSV。
- 学员学习进度百分比，例如已浏览页数/总页数。
- 课程分享链接支持权限校验，未登录时跳转登录。

建议工期：

- 1 名全栈开发：约 1-2 周。

### V3：企业化集成

目标是接入公司内部身份和培训体系。

功能范围：

- 对接企业 SSO、LDAP、飞书、企业微信或内部统一身份。
- 组织架构同步。
- 消息提醒。
- 更细的权限：课程创建者、课程管理员、部门管理员。
- 学习时长、互动完成率、测验得分等更完整数据。

建议工期：

- 视公司接口复杂度，约 2-6 周。

## 数据模型建议

基于 Supabase/PostgreSQL 设计。

### profiles

用户资料表。

- `id`：关联 Supabase Auth user id。
- `name`：姓名。
- `email`：邮箱。
- `employee_no`：工号，可选。
- `role`：`teacher`、`student`、`admin`。
- `created_at`。

### courses

课程表，复用当前云存储课程数据。

- `id`。
- `title`。
- `description`。
- `owner_id`。
- `stage_data` 或 `stage_id`：指向课程内容。
- `status`：`draft`、`published`、`archived`。
- `created_at`。
- `published_at`。

### course_assignments

课程分配表。

- `id`。
- `course_id`。
- `student_id`。
- `assigned_by`。
- `status`：`not_started`、`in_progress`、`completed`。
- `assigned_at`。
- `started_at`。
- `completed_at`。
- `due_at`，可选。

### course_progress_events

学习事件流水表，可选但建议保留。

- `id`。
- `course_id`。
- `student_id`。
- `event_type`：`open_course`、`view_scene`、`complete_course`、`quiz_submit`。
- `scene_id`，可选。
- `scene_order`，可选。
- `metadata`：JSONB。
- `created_at`。

### student_groups

V2 再做。

- `id`。
- `name`。
- `owner_id`。
- `created_at`。

### student_group_members

V2 再做。

- `group_id`。
- `student_id`。

## 权限设计

第一版建议保持简单。

- `student`：只能看自己被分配的课程和自己的学习记录。
- `teacher`：能看自己创建或拥有的课程，能分配给学员，能看这些课程的学习进度。
- `admin`：能管理所有课程、用户和学习记录。

Supabase RLS 建议：

- `profiles`：用户能读自己；teacher/admin 能读被管理学员的基础信息。
- `courses`：owner/admin 可写；published 且被分配的 student 可读。
- `course_assignments`：student 只能读/更新自己的 started/completed 字段；teacher/admin 可读写自己课程的分配。
- `course_progress_events`：student 可插入自己的事件；teacher/admin 可读自己课程的事件。

## 页面与接口建议

### 页面

- `/login`：登录页。
- `/teacher/courses`：老师课程列表。
- `/teacher/courses/[id]/assign`：课程分配页。
- `/teacher/courses/[id]/progress`：课程学习进度看板。
- `/student/courses`：学员课程列表。
- `/learn/[courseId]`：学员学习页，复用当前课堂播放体验，但隐藏编辑/生成能力。

### API

- `POST /api/courses/[id]/publish`。
- `POST /api/courses/[id]/assignments`。
- `GET /api/courses/[id]/progress`。
- `GET /api/student/courses`。
- `POST /api/learning/events`。
- `POST /api/learning/complete`。

## 关键实现点

- 学员学习页应复用现有 `Stage`/课堂播放组件，但进入只读模式。
- 课程内容需要稳定存储在云端，不能依赖 IndexedDB/localStorage。
- 完成规则第一版可以简单：访问课程后为 `in_progress`，浏览到最后一页或点击“完成学习”后为 `completed`。
- 如果课程里有 quiz，V2 可以把 quiz 提交作为完成条件之一。
- 分享链接不建议做“任何人可访问”的裸链接；至少需要登录后校验 assignment。

## 风险与待确认

- 账号来源：手工创建、批量导入，还是公司统一身份。
- 学习完成定义：浏览到最后一页、停留时长、测验通过，还是学员手动确认。
- 课程内容当前是否已完全云端化。如果仍依赖本地 IndexedDB，必须先完成课程云存储。
- 是否需要移动端体验。如果学员主要手机学习，学习页需要额外适配。
- 是否涉及培训合规审计。如果需要严肃留痕，事件表和服务端校验要更完整。

## 建议讨论结论

上班讨论时建议先定三个问题：

1. 学员账号从哪里来：手工、导入、统一身份。
2. 第一版“已学”的判定规则是什么。
3. 课程是否只分配给指定学员，还是也允许公开链接。

如果这三个问题确定，V1 的技术实现就比较清晰，可以按 1-2 周的小项目推进。
