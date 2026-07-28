# B2 拍板文档：widened-kind 校验放行（A/B/C）+ 离线真实数据验证设计

> 日期：2026-07-28
> 状态：**待拍板**。拍板前不改动 `lib/dsl-extensions/validate.ts` 或任何上游包。
> 作者：Kimi（应 Codex 分工建议第 2、3 项）

## 0. 现状与证据链

| 时间 | 事件 |
|---|---|
| 07-28 上午 | B2.2 Preview 报 `document_parity / read_failure / TypeError` |
| 07-28 下午 | Console 正文 `(void 0) is not a constructor` → 根因：tsconfig paths 将 `@openmaic/storage` 指向 `.d.ts`，Turbopack 运行时拿到零导出模块。修复 `ac3ab6bd`（paths→src + turbopack.resolveAlias→dist，未动上游包） |
| 07-28 傍晚 | 修复部署后 TypeError 消失；新现象：`document_bridge / failure / errorCode=validation` → parity `missing_document` |
| 07-28 傍晚 | 真实课程 JSON（`txo6PVFVnx`）本地探针定位：**8 个场景中唯一校验失败的是 1 个 `interactive` 场景**；剔除后 bridge `migrated` + parity `match` |

探针证据（`tests/document-bridge/real-course.probe.test.ts`，真实 BrowserDocumentStore × 真实校验器 × 真实课程 JSON）：

```text
[probe] stage valid: true
[probe] valid scene   type=slide   ×6
[probe] valid scene   type=quiz    ×1
[probe] INVALID scene id=0ozecsi5a2dn-jogVCOPj type=interactive title="互动演练：四象限法则"
完整课程  → bridge skipped / validation / parity missing_document   （= Preview 实测现象）
剔除 interactive → bridge migrated / parity match                    （= 修复后的预期）
```

**结论：B2.2 拿到真实课程 `match` 的唯一剩余阻塞，是 DSL 校验器不拥有 `interactive`/`pbl` 场景类型。** stage 形状（createdAt/updatedAt 数字、扩展字段）与 slide/quiz 场景的 round-trip 均已被真实数据证干净。

## 1. 第 3 项：widened-kind 校验放行 A/B/C

### 背景约束

上游 `BrowserDocumentStore` 的设计意图（`browser.ts` 构造器注释原文）：DSL `validateScene` 只拥有 slide/quiz；**"An app persisting a widened scene union (interactive / pbl / …) injects a validator that also accepts its own kinds, so the gate stays fail-loud for them."** 即：放行 widened kind 是上游明确留给应用层的责任，且要求"放行后仍保持 fail-loud"。

当前 RJ 的 `validateSceneExtended` 先跑 `dslValidateScene` 且失败即返回——DSL 不认识 RJ 类型，于是 widened kind 必然失败。这与注入点设计目的相悖（不是上游缺陷，是 RJ 适配层未完成作业）。

### 方案 A：RJ 校验层明确放行 widened kind（**推荐**）

改 `lib/dsl-extensions/validate.ts`（RJ 层，不碰上游）：

- 调 `dslValidateScene` 后，若错误**仅为** `/type` 的 "unknown scene type"，且 `scene.type ∈ {interactive, pbl}`（RJ 注册种类，来自 `lib/types/stage.ts` 的 `AppSceneContent` 判别联合），则吞掉该单一错误；**其余任何 DSL 错误（id/stageId/title/order/content 非对象/actions 结构）仍然 fail**。
- 追加 RJ 内容校验：`interactive` 要求 `content.type === 'interactive'` 且 `content.url` 为 https URL 或存在 `content.html`；`pbl` 要求 `content.type === 'pbl'` 且 `content.projectConfig` 为对象。不满足 → fail-loud。
- 存储层不变量（`assertStorableScene`：id/stageId/order）由上游包继续强制，不受影响。

影响评估：

| 维度 | 影响 |
|---|---|
| 上游 rebase | 零冲突（改动全部在 `lib/`） |
| 数据安全 | 保持 fail-loud：内容畸形、基础字段缺失、动作非法仍被拒；仅放开"类型判别"一项 |
| 测试面 | 既有 harness 的 interactive 用例预期反转（validation→migrated/match）；新增 pbl 用例、畸形 interactive 内容用例（缺 url/html → 仍拒） |
| 回退 | 单文件改动，revert 即恢复 |

### 方案 B：DocumentStore 外包适配（bridge 层绕过）

在 bridge 把 widened 场景改写成占位 slide 或旁路存储。把"场景内容保真"的责任从校验器移到 RJ 自研适配代码：round-trip 失真的风险自担、parity mismatch 难以归因、放弃存储层 fail-loud 保护。**不推荐**——它削弱的是 B2 双读比对想证明的东西本身。

### 方案 C：等上游 DSL 扩展机制

与上游设计意图直接相悖（见上方注释原文——上游已有"机制"：注入自定义 validator，且 B2.1 已经在用该注入点）；上游 v0.3.1 亦无新增扩展机制的动向。等于无限期搁置 B2.2，且 v0.3.x 的 interactive/pbl 恰是 RJ 课程的主力内容类型。**不推荐**。

### 推荐与实施清单（拍板后执行，预估半天）

1. 按方案 A 改 `validateSceneExtended`（约 40 行 + 注释）；
2. `lib/document-bridge/types.ts` bump `DOCUMENT_BRIDGE_VERSION`（`b2.1 → b2.2`）：`isSameSource` 含 bridgeVersion，bump 后此前 `failed` 的课程会在下次打开时自动重新桥接，无需手工清库；
3. 测试：更新 `documentstore-rj-roundtrip.test.ts` 的 interactive 用例预期（skipped→migrated/match）；新增 pbl、畸形 interactive（无 url 无 html、http url）用例；
4. 本地双绿（vitest + tsc）→ commit → push → Preview 复测 `txo6PVFVnx` 与 `oiqTbzCXwy`：预期 `document_bridge success` + `document_parity match`；
5. 拿到至少两门课的真实 `match` 后，出 B2.2 完工报告；在此之前不启动 B2.3。

## 2. 第 2 项：离线真实数据验证设计（harness 扩展）

目标：B2.2「真实历史 Dexie 验证」脱离 Vercel 部署循环，只读输入、可重复运行。

### 数据来源（两个，按需取用）

1. **云端课程 JSON**（已验证可用）：登录账号在课程页 Console 执行下载 snippet（见下），得到 `/api/courses/[id]` 原生 JSON。覆盖所有已发布课程——这正是 `cloud_hydration` 源的数据形状。
   ```js
   fetch('/api/courses/<id>').then(r=>r.json()).then(j=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(j)],{type:'application/json'}));a.download='course-<id>.json';a.click()})
   ```
2. **生产 origin 的历史 Dexie 导出**（验证 `legacy_dexie` 源需要）：生产浏览器（www.laixue.work）Console 只读导出 Dexie 的 stage/scenes/outlines 三表为 JSON。Preview 的 Dexie 恒为空，无法替代。**此 snippet 待写**（实施 A 时一并提供）。

### 脱敏纪律

课程 JSON 不含学员数据（内容即课程本体）；导出文件**仅存本机、不入库、不进 git**（放 `D:\WorkBuddy 地界\tmp\`，已在 .gitignore 之外手动管理）；导出人必须是对该课程有权限的账号（API 自身有 401/403 门禁）。

### 工具形态（已落地种子 → 演进步骤）

- **已有**：`tests/document-bridge/real-course.probe.test.ts`——`COURSE_JSON=<path>` 环境变量驱动，逐字段打印校验失败点 + bridge/parity 全链路结果；未设变量时整组 skip（CI 安全）。
- **下一步**（实施 A 时）：`scripts/offline-parity.mjs`（tsx），接受一个**目录**，对每门课输出一行结论：
  `courseId → bridge: migrated|skipped(errorCode) | parity: match|mismatch|missing_document | 失败字段路径`
  内部复用与探针相同的 mock 边界（supabase/ledger/diagnostics mock，真实 store + 真实校验器 + fake-indexeddb）。

### 验收标准（B2.2 完工的前置）

- 云端源：≥5 门含 interactive/pbl 的真实课程全部 `bridge migrated + parity match`；
- Dexie 源（历史数据）：测试账号生产 Dexie 导出后，离线比对全部 `match`（或对每门 mismatch 有明确、已测试的解释）；
- 上述证据进入 B2.2 完工报告，然后才评审 B2.3 切流。

## 3. 与既有路线图的衔接

```text
上游存储包冷安装 ✅   场景顺序归一 ✅   B2.1 本地影子复制 ✅   B2.2 双读比对代码 ✅
B2.2 Preview 验证  ◐ TypeError 已修；剩 widened-kind 放行（本文档第 1 节，待拍板）
B2.2 真实数据验证  ◐ 工具种子已建；批量脚本与 Dexie 导出 snippet 随实施 A 交付（本文档第 2 节）
B2.3 主读写切换    ⏸ 完工报告前不启动
RuntimeStore 服务端化 ⏸ 建议提到 B2.3 之前（绿地、低风险、价值最高，见 2026-07-28 战略评审）
```
