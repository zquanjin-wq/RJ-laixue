# Gate 1B 学习任务发布与学员进入闭环验收

- 日期：2026-08-11
- 规划与验收：Codex（Sol）
- 代码执行：Codex（Terra）
- 结论：通过

## 已完成

### 教师端

- `/admin` 增加学习任务入口。
- `/admin/learning-tasks` 提供任务列表、状态、课程、人数和时间信息。
- `/admin/learning-tasks/new` 支持选择课程、填写任务信息并指定学员。
- `/admin/learning-tasks/[id]` 支持草稿编辑、名单调整、发布、复制分享链接、关闭和归档。
- teacher 只能管理和预览自己创建的任务；admin 可以全览。

### 学员端

- `/learn/[token]` 完成登录回跳、名单校验、未开始、无效 token、关闭/归档和预览分流。
- 登录回跳仅接受站内路径。
- 非名单学员及非任务创建 teacher 不会获得任务详情。

### 不可变快照播放

- 新增鉴权快照接口 `/api/classroom/snapshot?taskId=...`。
- PC 课堂在 task 模式下跳过 IndexedDB，只读取任务快照；失败时不回落到最新 `courses.data`。
- 移动端保留 `taskId`，在服务端读取同一任务快照。
- `courseId` 始终保持真实课程 ID，`taskId` 作为独立上下文传递。
- 未将快照写入 `data/classrooms`，未新增临时文件机制。

### 事件边界

- task 模式事件携带 `taskId`。
- Gate 1B 暂不写任务进度，服务端返回 `recorded:false` 和 `task_event_collection_pending`。
- 未更新 `task_learners` 的状态、时间或进度；统一采集留给 Gate 1C。

## 验证结果

- TypeScript：通过。
- Gate 1A + Gate 1B 普通定向测试：88/88 通过。
- Live PostgreSQL：12/12 通过，0 skipped。
- 最终修复定向测试：32/32 通过。
- 全量 Vitest：286 个测试文件通过、3 个跳过；2534 项测试通过、21 项跳过。
- Gate 1B 相关 TypeScript/TSX 文件 Prettier：通过。

## 范围确认

- 未新增 hash、SHA-256 或额外完整性机制。
- 未实现章节进度、时长、检查题提交、AI 小结或统计看板。
- 未执行生产 SQL。
- 未提交、推送或部署。
- 保留并避开工作树中与 Gate 1B 无关的既有修改及 `docs/user-guide/`。

## Gate 结论

教师创建并发布任务、指定学员、复制链接，以及学员通过分享链接读取发布时不可变课程快照的最小闭环已经成立。Gate 1B 通过，可以进入 Gate 1C 的统一学习事件与进度采集设计。
