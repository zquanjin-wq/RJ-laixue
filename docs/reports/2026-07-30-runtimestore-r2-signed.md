# R2 RuntimeStore 影子双写 — 正式签字记录（SIGNED）

- 日期：2026-07-30
- 签字方：Codex（RJ-laixue 上游 v0.3.1 对齐主线工程执行负责人）
- 实施方：Kimi K3
- 签字 commit 基线：`30c71f01`（分支 `test/documentstore-parity`）

## 签字原文要点

> 正式签字：R2 RuntimeStore 影子双写验收通过（SIGNED）。
> 后续按已拍板顺序执行：隔离 Supabase Preview/Scratch → 迁移与安全边界验证 →
> 受控开启影子写并观察遥测 → playback R2.1 → R3 总设计。
> 本签字仅确认 R2 代码与设计可以入库，不授权执行生产 SQL、开启生产开关或 DROP runtime 表。

## 验收范围确认

- **R2 限定为 chat + quizAttempt** 两类影子写。
- **playback 已移出 R2**，另立 R2.1 前置设计卡（pending/outbox、刷新及跨标签页
  恢复语义是 R3 切读门禁的输入）。
- quiz 使用**单键提交 envelope**（`quizAnswers:<sceneId>` = `{v, attemptId, answers}`），
  满足原子性及持久化幂等锚点要求；影子路径的 attemptId 与 answers 只从持久化
  envelope 读回。
- DSL phase 统一为 `submitted`/`reviewed`。
- 门禁：专项 69/69（Codex 独立重跑确认）、`tsc --noEmit` 0 error、全量 2077 passed
  （仅 8 个存量 round-trip 导入失败基线）。

## 关键 commit 链

| Commit | 内容 |
|---|---|
| `692cf9b7` | R2 设计稿 v2（Codex 终审 4 拍板 + 2 P0） |
| `5e6c1366` | R2 初版实施（代码 + 30 测试） |
| `4244e4ae` | R2 初版实施报告 |
| `cbfd3b91` | 验收卡修订：单键 envelope 原子写；playback 移出 R2 |
| `57a10a18` | 设计稿 v2.1 勘误 + 实施报告 v2 |
| `30c71f01` | 验收收尾：设计稿 §1.2 正文改写 + 报告表述范围收窄 |

## 后续顺序（Codex 拍板）

1. **建立隔离 Supabase Preview/Scratch**——硬前提：Vercel Preview 不得与生产共用
   Supabase 项目，否则任何「预览迁移」= 改生产库，应禁止。
2. 仅在隔离环境执行迁移，验证路由、RLS、service role、RPC EXECUTE 收口。
3. 受控开启 R2 chat + quizAttempt 影子写（`NEXT_PUBLIC_RUNTIME_SHADOW=1`），
   观察 `runtime_shadow` 遥测成功率分布（此时再谈 SLO）。
4. playback R2.1 前置设计卡。
5. R3（切读源）总设计稿。

## 边界重申

本签字 ≠ 授权生产执行 SQL、开启生产开关或 DROP runtime 表。生产迁移需第 2 步
验证通过后由负责人单独授权；回滚只关开关/回退代码、保留 runtime 表，仅
「未写入任何业务 runtime 数据」的窗口允许 DROP 物理回滚。
