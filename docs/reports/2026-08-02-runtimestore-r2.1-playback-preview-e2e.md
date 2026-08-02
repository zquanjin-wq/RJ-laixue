# R2.1 playback Preview 受控开启 E2E 验证报告

- 日期：2026-08-02
- 环境：Vercel Preview（branch `test/documentstore-parity`，deployment `dpl_3GKCce4pG3gj31XnzKi7dUmJdAcV`）+ Supabase Preview（ufwkylcsrppaamzqsvgx）
- 前置：A2 SIGNED（3faccb3a）；负责人授权在 Preview 设置 `NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK=1`

## 0. 开启过程中的一个插曲（重要教训）

首次验证发现影子零请求。排查确认：**当时的部署构建早于环境变量添加**，
`NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK` 在 bundle 中仍是字面量（未内联），
运行时子开关实际为关——双开关门禁按设计正确拒发，本地落盘不受影响。
处置：通过 Vercel UI 对该 Preview 部署做**无缓存 Redeploy**（Production 未触碰；
过程中曾弹出生产 main 部署的 Redeploy 对话框，已取消，未执行）。
新构建 Ready 后 bundle 检测确认变量已内联（字面量消失）。

教训固化：`NEXT_PUBLIC_*` 变量是构建期内联，新增/修改后必须无缓存 Redeploy
才生效；验证前先用 bundle 字面量检测法确认开关状态。

## 1. E2E 操作序列（WebBridge 驱动真实浏览器，已登录态）

课堂 `u_sj94ssIi`：播放 12s → 暂停（flush）→ 切场景（Next scene）→ 播放 8s → 暂停。

## 2. 核验结果

| 核验项 | 结果 | 证据 |
|---|---|---|
| pb: 会话与 records | ✅ | `POST /api/runtime/v1/sessions/pb%3Au_sj94ssIi/records` ×2，均 201 |
| record id 幂等锚点 | ✅ | `pb:u_sj94ssIi:d8a544eb-…`（seq 1）、第二条新 eventId——每次落盘新 UUID |
| payload 契约 | ✅ | `{v:1, sceneId, sceneIndex, actionIndex, consumedDiscussions, capturedAt}`（设计卡 §4.2/§4.5） |
| capturedAt 来源 | ✅ | 与 Dexie 行 capturedAt 一致（`2026-08-02T08:12:02.282Z`） |
| 条件清除 | ✅ | 两次落盘后 Dexie `shadowPending` 均为 null，`runtimeShadowEventId` 已刷新为新值 |
| 切场景语义 | ✅ | 第二条 record 的 sceneId 为新场景（biSAFHEe…） |
| 遥测落地 | ✅ | Vercel logs：`runtime_shadow {outcome:"ok", op:"append_record", kind:"playback"}` |
| 双开关门禁 | ✅ | 变量未内联期间零影子请求（插曲验证）；内联后正常发送 |
| chat/quiz 观察期 | ✅ 不受影响 | 同期 chat 遥测正常（create_session/append_record ok） |

## 3. 观察到的边界事项（非 A2 问题，移交 R2 观察期跟踪）

- chat 影子出现 1 条 `runtime_shadow {outcome:"idempotency_conflict", op:"append_record", kind:"chat"}`
  （record id 相同但内容不同，409 响亮计数不重试——R2 已签字语义）。对应网络层确有
  chat records 409。建议 R2 观察期分析该 chat 会话的记录 ID 生成是否存在内容漂移，
  不影响本次 playback E2E 结论。

## 4. 结论

R2.1 A2 playback 影子写在 Preview 真实环境端到端工作正常：会话/records/capturedAt
契约/条件清除/遥测/双开关门禁全部符合设计卡 v1.3。建议 R2.1 收官，
R3 总设计稿以本报告 + R2.1 设计卡为切读门禁输入。

## 5. 当前开关状态

- Preview：`NEXT_PUBLIC_RUNTIME_SHADOW=1`、`NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK=1`（观察中）
- Production：两者均未设置，SQL 未执行，红线保持
