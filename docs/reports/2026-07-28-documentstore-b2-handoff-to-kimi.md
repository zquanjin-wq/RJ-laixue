# RJ-laixue DocumentStore B2 交接（2026-07-28）

## 一句话结论

上游 v0.3.1 的 `@openmaic/storage`（DocumentStore / RuntimeStore）已经安全冷安装；
RJ 业务尚未切到 DocumentStore。当前唯一进行中的事项是 **B2.2 影子校验**：用
Preview 验证“云端课程加载后，复制到本地 DocumentStore 的副本与原课程一致”。
它目前发现了一个 **仅在 Preview 影子读路径中的 `TypeError`**；生产课程展示、
原 Dexie 读写和 Supabase 均不受影响。

## 架构与边界

```text
当前生产主路径
课程文档：Dexie IndexedDB + 云课程 API/Supabase 回退
聊天、测验、播放、媒体、生成状态：Dexie

B2 影子路径（仅开关启用）
课程成功加载 -> 异步复制到 BrowserDocumentStore -> 异步指纹比对
                 失败时永远回退/保持 Dexie 与既有 UI

尚未实施
DocumentStore 主读写切流
RuntimeStore 应用接入
learnerKey / RuntimeStore 云端后端
Supabase RuntimeStore/DocumentStore adapter
Supabase schema、RLS、chat/PBL/quiz/playback 改造
```

最高约束：`packages/@openmaic/*` 不作无记录修改；RJ 扩展放 `lib/`。当前 B2
没有修改上游包。禁止把影子失败当作上线故障而改写或删除用户的 Dexie 数据。

## 已完成（可视为基线）

| 范围 | 状态 | 关键提交/结论 |
|---|---|---|
| Part A DSL runtime envelope | 完成 | 已先前落地；Turbopack 使用 DSL built entry。 |
| B0 DocumentStore 冷安装 | 完成 | 上游 `6d6e1ac8`，RJ `1d52aea7`。 |
| B1 RuntimeStore 冷安装 | 完成 | 上游 `1c507884`，RJ `a05ffc22`。只装包和测试，零业务导入。 |
| 场景顺序归一 | 完成并生产验证 | `177b879`；存量课程顺序稳定化，给 DocumentStore 按 `scene.order` 重组扫清历史乱序。 |
| B2.1 本地桥接 | 完成、默认关闭 | `9d765d57`；账号命名空间、幂等 ledger、失败保留 Dexie。 |
| B2.2 影子校验 | 进行中 | `55d78d59` + `e0895a74` 起，Preview 专用验证。 |
| CI | 已恢复绿基线 | E2E 已拆分 smoke/full；此前问题与 B2 核心逻辑无关。 |

## 身份与未来服务端路线（已决策）

- `learnerKey = Supabase auth.uid()`；6 位 access code 绑定到已登录的 Supabase
  Auth 账号，不是匿名身份。
- 上游 reference server / `pg.ts` **不能直接部署**：它明确不含生产身份、授权和
  多租户隔离。
- 未来推荐路线：上游 HTTP storage contract -> RJ Next.js API routes ->
  `api-guard` + Supabase Auth/RBAC/RLS -> 可替换后端（云端 Supabase / 私有化
  Postgres）。不要让浏览器直接使用 PostgREST 实现 append-only/CAS。
- Kimi 当前负责元素级 AI 编辑；不要把该工作与 B2 或服务端持久化 adapter 混入
  同一提交。

## 当前工作区与分支

隔离 worktree（干净）：

```text
D:\WorkBuddy 地界\RJ-laixue-storage-b2
branch: test/documentstore-parity
```

该分支领先远端的本地提交（按先后顺序）：

```text
99684ba9 fix(storage): observe cloud hydration parity
a8ec49ca fix(storage): classify DocumentStore parity read failures
b6b6a889 fix(storage): identify parity read error class
ffa96dac chore(storage): expose preview parity exception locally
bcad19a7 fix(storage): retain preview parity exception detail
```

其中前四个已在此前 Preview 验证过程中推送/部署过的可能性取决于操作者；以
`git log origin/test/documentstore-parity..test/documentstore-parity` 为准。一次安全
推送命令会推送所有缺失提交：

```powershell
cd "D:\WorkBuddy 地界\RJ-laixue-storage-b2"
git push origin test/documentstore-parity
```

不要在共享主 worktree `D:\WorkBuddy 地界\RJ-laixue` 中整理、revert 或 stage
其他人的未提交 course-assets / element-editing 文件。

## 当前 Preview 验证的开关

只应配置在 Vercel **Preview**，不得配置到 Production：

```text
NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE=1
NEXT_PUBLIC_DOCUMENT_STORE_PARITY_CHECK=1
```

此开关使桥接与比对异步运行。它们不等待、不改变课堂页面数据来源、不把云端课程
写回既有 Dexie。

## 已观察到的故障

测试账号 `d7274fee-2581-4cea-ad9d-5a405baa54ec` 在 Preview 打开云端课程后，Vercel
服务端诊断出现：

```text
event: document_parity
outcome: read_failure
source: cloud_hydration
errorPhase: load_document
errorCode: unknown
errorName: TypeError
```

已复现课程包括 `oiqTbzCXwy`、`txo6PVFVnx`、`HsxJTCOZuK`。`source=cloud_hydration`
是预期的 Preview 特例：Preview 与生产不是同源，Preview 的历史 Dexie 为空；因此
云课程成功加载后只构造快照进行影子桥接/比对，**不能据此证明历史 Dexie 迁移已
通过**。

该异常位置已精确到：

```text
compareLegacyDocument()
  -> BrowserDocumentStore.loadDocument(courseId)
  -> TypeError
```

不是：Supabase 身份、云课程 HTTP 加载、课堂 UI、正式 Dexie 主路径。

## 为什么前一轮 Console 显示 `error: {}`

`createLogger` 对 JavaScript `Error` 做 JSON 序列化，结果为空对象。因此
`ffa96dac` 的 logger 记录无法显示异常正文。这不是上游存储本身的结论。

最新 `bcad19a7` 已改为在 **仅启用 parity 的 Preview 浏览器 Console** 使用原生
`console.warn` 输出：

```text
[DocumentBridge] Document parity read failed (local Preview console only):
TypeError: <具体错误信息>
```

完整异常文本不会发送到 `/api/client-diagnostics` 或 Vercel 日志。它只作为受控的
本机浏览器排障信息。

## 给 Kimi 的下一步（严格按序）

1. 推送 `test/documentstore-parity`，确认 Preview 已包含 `bcad19a7`。
2. 在该 Preview 用测试账号打开一门已有课程，按 F12 -> Console，搜索
   `Document parity read failed`；复制 `TypeError: ...` 的**完整文本与 stack**。
3. 只根据该异常修复 `lib/document-bridge/` 或 RJ 适配层；先新增最小复现测试。
   不修改 `packages/@openmaic/storage`，除非确属上游缺陷且先单独上报方案。
4. 验证至少两个云课程得到 `document_parity` 的 `match`（或有明确、已测试的
   mismatch 解释），并确认课堂仍正常、无 Dexie 写入副作用。
5. 产出独立 commit、更新本报告/单独 B2.2 完工报告、CI 和 Preview 构建绿后，
   才评审是否允许合并 B2.2；在此之前绝不将 DocumentStore 设为主读写来源。

## 相关文件

```text
lib/document-bridge/bridge.ts          # 异步桥接、影子比对、开关、失败回退
lib/document-bridge/identity.ts        # SHA-256 前 32 hex（128 bit）账号命名空间
lib/document-bridge/ledger.ts          # 每课程桥接状态（未迁移/迁移中/成功/失败）
lib/document-bridge/diagnostics.ts     # 仅枚举化服务端诊断
lib/document-bridge/types.ts
app/api/client-diagnostics/route.ts    # Auth + 限流的诊断接收端
app/classroom/[id]/page.tsx             # 云课程 fallback 后触发 Preview 影子快照
lib/store/stage.ts                      # 原 Dexie 成功加载后的影子路径
tests/document-bridge/bridge-fallback.test.ts
tests/document-bridge/identity-diagnostics.test.ts
docs/reports/2026-07-28-b2-2-document-parity.md
packages/@openmaic/storage/src/document/browser.ts  # 只读上游实现，勿直接改
```

## 验收底线

- 新旧数据双读不一致或影子读失败：保留 Dexie 主路径，停止切流。
- 不允许仅因“CI 绿”或“课程页面可打开”就宣称 B2 完成。
- 不允许在未取得 `match` 数据前开始 RuntimeStore、chat/PBL/quiz 业务切流。
- 如果要回退 Preview：关闭两个 Preview 环境变量或不合并该分支即可；本阶段没有
  写入生产 Supabase，也没有改写既有 Dexie 主数据。
