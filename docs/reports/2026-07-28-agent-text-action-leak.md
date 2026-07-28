# Bug 立案：智能体文本片段误分类混入场景 actions 数组

> 日期：2026-07-28
> 严重度：中（运行时静默容忍，但阻断 DocumentStore 影子复制，且属数据契约污染）
> 建议负责人：Codex / WorkBuddy（生成管线地盘）；Kimi 提供证据与探针
> 拍板：①源头修数据 + ③修生成链路根因（2026-07-28 负责人同意）

## 1. 症状

课程 `1I_kD25GX1` 在 B2.2 影子复制中被 DSL 契约校验拒绝
（`document_bridge / failure / errorCode: validation`）。定位为场景
`f2uC_5h8tlhYjy8_twk5Y`（slide，title "面试实战案例：考察关键经验与技能"）
的 `actions[10]`：

```json
{ "id": "action_Zpjc_qUa", "type": "text" }
```

`"text"` 不是 DSL 契约的动作类型（契约集合：spotlight/laser/play_video/speech/
wb_*/discussion/widget_*），RJ 的 Action 类型也是 DSL 的纯 re-export、无应用层
扩展——即 `"text"` 动作在任何一方的类型系统里都不合法。

## 2. 根因推断

多智能体响应格式（`lib/orchestration/director-graph.ts:103-118`）是
`[{"type":"text","content":"..."},{"type":"action",...}]`：`type:'text'` 标记
**文本片段**，`type:'action'` 标记动作。该伪条目无 payload、带有动作风格的
`action_` 前缀 id——高度疑似智能体输出解析/持久化路径把文本片段误分类为
动作写进了 `scene.actions`。

运行时未暴露是因为播放引擎对未知动作类型静默跳过。

**待排查的持久化路径**（建议起点）：agent 工具链中把智能体输出写回场景
actions 的位置，重点看 `lib/agent/tools/regenerate-scene-actions.ts`、
`regenerate-scene.ts` 与 Pro 模式编辑应用 patch 的路径——检查是否存在
"未按 `type==='action'` 过滤就把响应数组条目当作动作持久化"的分支。

## 3. 修复建议（根因）

1. 持久化边界按契约过滤：写入 `scene.actions` 前用 DSL 的 `isActionType`
   （或 `validateAction`）过滤/拒绝非动作条目，并对丢弃项计数上报
   （client-diagnostics），避免静默吞错；
2. 在课程保存边界（cloud-sync 上传）加 `validateScene` 级检查或告警，
   让脏数据在产生时即暴露，而不是在存储迁移时才被发现；
3. 修复后跑生成回归（至少覆盖触发该课程的多智能体回合场景）。

## 4. 存量数据修复规格（拍板①，一次性）

课程 `1I_kD25GX1`，删除 1 条伪动作：

- **Supabase**（courses 行 data JSONB）：从场景 `f2uC_5h8tlhYjy8_twk5Y` 的
  `actions` 数组中删除 `id = 'action_Zpjc_qUa'` 的条目（该场景 actions 应
  从 11 条变为 10 条，其余顺序不动）；
- **Dexie**（测试账号各浏览器本地缓存）：云端修复后需刷新本地副本
  （重新保存课程或清除该课程的本地缓存），否则 `legacy_dexie` 源的影子
  复制会继续按预期 fail-loud（errorCode: validation + courseId 可识别）；
- 修复后在开启 B2 开关的 Preview 重新打开该课程，预期
  `document_bridge / success` + `document_parity / match`；
- 建议同时用探针（`COURSE_JSON=... pnpm vitest run
  tests/document-bridge/real-course.probe.test.ts`）对测试账号其余课程做
  一次批量体检，确认没有第二门课携带同类伪动作。

## 5. 复现方式

```bash
# 导出课程 JSON（课程页 Console 下载 snippet，见 B2.2 完工报告）
COURSE_JSON=<path-to-course-1I_kD25GX1.json> \
  pnpm vitest run tests/document-bridge/real-course.probe.test.ts
# 预期：该场景报 INVALID，errors 含 /actions/10/type: unknown action type: "text"
```
