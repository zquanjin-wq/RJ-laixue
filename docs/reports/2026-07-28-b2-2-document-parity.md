# B2.2 Report: DocumentStore dual-read parity observation

Date: 2026-07-28
Scope: observe parity between the legacy Dexie course document and the B2.1
DocumentStore shadow copy. This change does not make DocumentStore an active
read or write source.

## Safety boundary

- The UI continues to load course documents from the existing Dexie path.
- A parity check is scheduled only after that Dexie load succeeds.
- It is enabled only when both `NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE=1` and
  `NEXT_PUBLIC_DOCUMENT_STORE_PARITY_CHECK=1` are set. Both default to off.
- Bridge then comparison share one idle-time serial queue. The comparison sees
  the shadow copy after a successful bridge attempt without blocking the user.
- Missing DocumentStore data, a mismatch, authentication failure, or IndexedDB
  failure is logged as an observation and returns control to the legacy path;
  it cannot throw into course loading.

## What is compared

The fingerprint is SHA-256 over a stable JSON representation of the stage,
the scenes sorted by `order` then `id`, and the optional outline record. This
compares document meaning rather than IndexedDB implementation details.

## Diagnostics

The authenticated, rate-limited `/api/client-diagnostics` endpoint accepts
`document_parity` events. Successful matches omit the course ID; non-matches
carry it for support triage. Outcomes are `match`, `missing_document`,
`mismatch`, `read_failure`, and `identity`. Every event includes a bounded
duration bucket and parity version, so match rate and latency can be measured.
Diagnostic delivery is best-effort and never participates in the course path.

### Preview validation source

Preview deployments use a different `vercel.app` origin and therefore begin
with an empty legacy Dexie database. A cloud-loaded course would otherwise
never enter the legacy-load bridge path, producing no diagnostic at all.

When the existing bridge and parity flags are enabled, a successful cloud
course hydration now performs the same isolated DocumentStore shadow copy and
comparison. Its event is explicitly labeled `source: cloud_hydration`; legacy
Dexie reads remain labeled `source: legacy_dexie`. The cloud path never writes
legacy Dexie and never changes the classroom's active source. It validates the
Preview end-to-end path, but it is not evidence that historical Dexie migration
is safe; that remains a separate B2.2 production-cache gate.

## Automated verification

- match: reports success without a course ID;
- absent shadow document: reports `missing_document`;
- changed document: reports `mismatch`;
- IndexedDB exception: reports `read_failure` and resolves safely;
- disabled parity flag: does not authenticate or open DocumentStore;
- existing B2.1 bridge fallback tests remain in the same focused suite.

## B2.3 gate

Do not switch any course read/write path to DocumentStore until a controlled
deployment has collected representative parity data with the flags enabled.
The evidence must show no unexplained mismatch/read-failure pattern, and the
kill switch must remain tested before proposing a primary-read task.

<!-- Trigger Preview deployment for B2.2 validation. -->
# Preview 读失败诊断（2026-07-28）

首次 Preview 验证确认 `cloud_hydration` 影子路径已触发；两个课程均报告
`read_failure/unknown`。该路径不改写 Dexie、不改变课堂展示，也不代表生产
课程不可读。后续诊断将只上报受限的失败阶段（身份、DocumentStore 读取或指纹
比对）及错误类别（例如 IndexedDB 版本或事务状态），不记录原始异常、课程正文
或用户敏感资料。

第二轮 Preview 读失败将额外记录标准化的浏览器异常名称，以及更细的本地存储
类别（模式缺失、不可用、版本、事务或 storage 读取）。这些字段均为枚举，仍不
包含原始异常文本或课程数据。

若仍发生读取失败，完整异常仅输出到启用 Preview parity 开关的浏览器 Console，
供受控的人工排障使用；服务端诊断端点继续只接收枚举字段。
项目 logger 对 `Error` 的 JSON 序列化会丢失正文，因此 Preview Console 使用原生
`console.warn` 输出“异常名称: 异常信息”；该文本不会发往服务器。

## 根因定位与修复（2026-07-28，Kimi）

**Console 正文**（Preview 实测）：`TypeError: (void 0) is not a constructor`。

**根因**：tsconfig paths 将 `@openmaic/storage` 指向
`packages/@openmaic/storage/dist/index.d.ts`（纯类型声明，零运行时导出）。
tsc 因此获得类型，但 Turbopack/webpack 打包同样跟随 paths，浏览器运行时拿到的
`BrowserDocumentStore` 是 `undefined`；`storeFor()` 中
`new BrowserDocumentStore(...)` 于是抛出上述 TypeError。bridge（影子写）与
parity（影子读）都在同一构造调用处失败，因此影子库从未写入数据——这与
「read_failure 而非 missing_document」的诊断完全一致。dsl 当日已在
`eab76ae0` 以 `turbopack.resolveAlias` 指向 dist 构建入口解决同类问题，
storage 在 B0 冷安装时未获得同等处理。

**为何两天未定位**：既有测试从未执行过该解析路径——RJ 侧测试 mock 掉
`@openmaic/storage`，上游契约测试不经过 Next 打包器，vitest 走 node_modules
解析（正常）。故障组合「Turbopack 生产构建 × paths 指向 .d.ts」只在开启开关的
Preview 首次执行。

**修复**（RJ 配置层，未动上游包）：

- `tsconfig.json`：`@openmaic/storage` paths 改指 `src/index.ts`（与 dsl 一致）；
- `next.config.ts`：`turbopack.resolveAlias` 增加
  `'@openmaic/storage': './packages/@openmaic/storage/dist/index.js'`
  （与 dsl 同款，postinstall 在 `next build` 前构建该入口）；
- 新增 `tests/openmaic-package-resolution.test.ts` 配置哨兵：paths 不得指向
  `.d.ts`、指向 source 的包必须有 dist 别名，防止同类不对称再次发生。

**验证**：

- 新增 `tests/document-bridge/documentstore-rj-roundtrip.test.ts`（真实
  BrowserDocumentStore × 真实 RJ 校验器 × RJ 扩展文档形状，fake-indexeddb）：
  slide/quiz 课程 round-trip `match`；同时固化发现的 widened-kind 缺口——
  含 interactive/pbl 场景的课程当前无法进入影子路径（DSL validateScene 只拥有
  slide/quiz，`validateSceneExtended` 先跑 DSL 校验），表现为
  validation → missing_document，需后续在 RJ 校验层单独立项放行。
- document-bridge 全套 15 测试 + 哨兵 2 测试通过；`tsc --noEmit` 通过。
- 本地未跑完整 `next build`（耗时与 env 限制）；修复机制与 dsl 生产实证
  （`eab76ae0`）结构对称。最终以 Preview 复测 `document_parity = match` 为准。
