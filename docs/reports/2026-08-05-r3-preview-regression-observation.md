# RuntimeStore R3 Preview 人工回归与观察期报告

日期：2026-08-05  
分支：`test/r3-line`  
部署：`4a570ff1` / Vercel `ATycMRWNLVWRp7oUih2m9rvanyPm`  
环境：Preview only  
结论：**Production NO-GO（Playback P0 阻断）**

## 1. 边界

- 未修改代码、数据库或环境变量。
- 未执行 Supabase SQL。
- 未触碰 Production 或 R3.x dual-read。
- 复用 Preview 测试课程 `7YsMN9Bdoz` 与测试账号。

## 2. 回归结果

| kind | 业务操作 | Runtime 结果 | 判定 |
|---|---|---|---|
| quizAttempt | 提交、批改、重新答题 | 同一新 attempt：create 201 → submitted 201 → reviewed 201 → completed 200 → archived 200 | PASS |
| chat | 创建 Q&A、发送消息、结束讨论 | create 201；records 均 201；status 200；`runtime_shadow` 遥测为 ok | 写路径 PASS；业务回复 PARTIAL |
| playback | 播放、重新进入已完成课程、切场景 | 首轮 records 201、status 200；随后同一 `pb:<stageId>` records 持续 409 | **FAIL / P0** |

## 3. Quiz 证据

新 attempt：`163aee7d-fd38-43df-9fbd-70f1672bcdf1`。

1. 09:09:46 `POST /api/runtime/v1/sessions` → 201
2. 09:09:51 submitted record → 201
3. 09:09:54 reviewed record → 201
4. 09:09:57 completed status → 200
5. 09:10:41 archived status → 200

刷新后没有重发上述成功条目。R3.2 修正后的严格链通过。

观察项：10:09:10 仍出现旧失败 attempt `deffc368-...` 的 record 409。该条来自修复前遗留 outbox，而非本轮新 attempt，说明 Preview 浏览器中仍存在不会自动终结的历史失败条目。

## 4. Chat 证据

本轮会话：`session-1785896301658-thjgajojyh`。

- 10:18:22 create → 201
- 10:18:25、10:18:30、10:20:14 records → 201
- 10:20:18 status → 200
- 对应 `runtime_shadow` create/append/status 遥测均为 `outcome: ok`

页面成功创建 Q&A、展示测试消息并进入已结束状态。服务端 `/api/chat` 同时记录 `Agent "林老师" produced empty response (no text, no actions)`；因此 Runtime 写链通过，但本轮没有获得完整教师文本回复，业务体验只能判为 PARTIAL，需区分 Provider/Agent 输出问题与 RuntimeStore 问题。

## 5. Playback P0 阻断

会话：`pb:7YsMN9Bdoz`。

- 10:10:13 record → 201
- 10:10:29 record → 201
- 10:10:33 completed status → 200
- 10:11:19 起，新进度 record 对同一会话连续返回 409
- 后续 409 出现在 10:11:26、10:11:34、10:11:42、10:12:00、10:12:48、10:17:51

复现语义：课程完成后重新进入/继续产生 Playback 快照，客户端仍复用确定性会话 `pb:<stageId>`；服务端已将该会话标为 completed，禁止继续 append，因而返回 `INACTIVE_SESSION` 类 409。outbox 把该响应留在退避重试路径，无法排空。

同时观察到与 Playback 请求相邻的 `/api/client-diagnostics` 400（10:10:29、10:11:19、10:11:34）。Vercel 列表未展示请求体，尚不能断言具体校验字段，但遥测失败本身需要纳入修复。

## 6. 观察期异常汇总

| 信号 | 结果 |
|---|---|
| Runtime 5xx | 本窗口未观察到 |
| 新 Quiz 409 | 0 |
| Chat record/status 4xx/5xx | 0 |
| Playback 409 | 连续复现，且退避后重试 |
| client-diagnostics 400 | Playback 相邻窗口至少 3 次 |
| dead/superseded | Vercel 日志无法直接读取 IndexedDB 状态，未作无证据断言 |
| outbox 排空 | 新 Quiz 链已排空；Playback 未排空；修复前旧 Quiz 条目仍会复活 |

## 7. Production 决策

**当前不得签 Production 部署卡。**

解除阻断至少需要：

1. 拍板 completed Playback 会话再次产生快照时的生命周期：新 session identity、显式 reopen，或禁止/丢弃 completed 后进度；不得继续无限重试不可恢复的 409。
2. 增加真实 E2E 门禁：完成课程 → 刷新/重新进入 → 播放或切场景，验证无 409 且 outbox 最终排空。
3. 查明 Playback 相邻 `client-diagnostics` 400 并补遥测契约测试。
4. 对修复前旧 Quiz 失败条目提供 Preview 清理或一次性终结方案，再开始干净观察窗口。
5. Chat 另做一次能产生完整教师回复的业务回归；Runtime 写链本轮无需返工。

