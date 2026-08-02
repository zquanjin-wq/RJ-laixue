# R2.1 A2 验收签字记录（SIGNED）

- 日期：2026-08-02
- 验收人：Codex（联合评审）
- 验收对象：R2.1 playback 影子写 A2 实施
- 签字 commit：`3faccb3a`（含两轮复审卡修复：`30f66c35`、`3faccb3a`；A2 主体 `f2b532e1`）

## 验收结论

R2.1 A2 实施验收通过，代码签字。幂等状态机四态分类、事务内重新判定、异常状态重锚及 capturedAt 当前行语义均符合设计卡 v1.3。

独立验证：9 个测试文件 88/88；tsc 仅 4 个既有 pg/pg-mem 环境错误；状态 B 零请求/pending 不复活；状态 D 全新一致 ID；原子条件清除、legacy CAS、completed PATCH 补偿、source: local_drop 均成立；chat/quiz 路径未改；工作树干净；子开关未设置，Preview 无提前影子请求。

## 两轮复审卡关闭记录

| 轮次 | 条目 | 修复 commit |
|---|---|---|
| 第一轮 | 条件清除非原子（跨标签页误清） | `30f66c35` Dexie rw 事务 |
| 第一轮 | legacy 升级读后写覆盖竞态 | `30f66c35` 事务内 CAS |
| 第一轮 | completed PATCH 失败仍删 pending | `30f66c35` PATCH 结果检查 |
| 第一轮 | source: local_drop 未进遥测 | `30f66c35` 客户端+服务端白名单 |
| 第二轮 | 幂等状态机状态混淆（legacy vs 已成功） | `3faccb3a` 四态分类 + 事务内重判 |

## 当前授权边界（签字时确认）

- A2 代码验收完成；
- **尚未授权修改 Vercel Preview 环境变量或 redeploy**；
- Production 开关、SQL 及部署继续禁止。

## 下一步（需单独申请）

1. 仅在 Vercel Preview 设置 `NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK=1`；
2. 执行一次无缓存 Redeploy；
3. 登录态真实 playback E2E：核验 `pb:` 会话、快照 records、completed 状态、pending 清除及 runtime_shadow 遥测（含 superseded/local_drop）；
4. Production 不变。
