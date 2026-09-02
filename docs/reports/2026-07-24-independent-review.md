# RuntimeStore 四阶段计划独立评审

评审日期：2026-07-24  
范围：只读核验当前 `main`、上游提交对象及指定材料。未修改业务代码或配置。

> 重要限制：题面所称“四阶段计划全文”实际只包含“把我上一轮更新后的执行清单整段贴在这里”的占位文字，未提供计划正文。因此，下列结论仅核验题面明确列出的五项主张及材料中可见的 Phase 2/4 描述；无法确认任何未贴出的验收标准、开关名称或迁移步骤是否已被计划覆盖。

## 结论

**需要重大修正。**

三提交的拓扑顺序本身正确，且“先写端归一再让 DocumentStore 按 `order` 读取”是可行方向；但计划至少遗漏了：自动保存并非唯一的 `saveStageToCloud` 调用点、旧 Dexie 到新独立 IndexedDB 的数据迁移/回退、以及 Supabase 的无版本 last-write-wins 覆盖风险。将这些遗漏留到实施时，会造成错误地关闭手动保存或在切流时看似“丢失”本地课程。

## 逐项核实结果

### 1. seq 修复方案：部分同意

**判断：** 对 DocumentStore 路径，写端归一优于仅在其后的读端加 wrapper；但不能把它当作无副作用的“刷新字段”操作，且必须只在完成一次历史数据恢复后写入。

**代码证据：**

- 当前写路径已经将每个场景的 `order` 和 `seq` 一同覆盖为数组下标：`lib/utils/stage-storage.ts:77-88`。这不是新增的轻量修复，而是会永久丢弃原始 `order` 的既有语义。
- 未可信课程的恢复路径先按 `createdAt` 排序，再在事务中回写场景并置 `sceneOrderTrusted=true`：`lib/utils/stage-storage.ts:151-166`、`190-211`。因此若在这一步之前对历史数据直接“以现有数组的 seq 刷 order”，会把尚未恢复的错误顺序固化。
- `scene-order` 明确规定不以原始 `order` 作为展示/恢复依据，并最终同时规范化两个字段：`lib/utils/scene-order.ts:65-72`、`227-230`。没有发现回填逻辑依赖原始 `order`；它依赖 `createdAt`/`updatedAt`/`id`，所以这一点不存在反对证据。
- 但上游 DocumentStore 的重组硬编码 `sort((a,b) => a.order-b.order)`：`6d6e1ac8:packages/@openmaic/storage/src/document/adapter.ts:49-62`。若只在 reassemble 之后加 wrapper，原始数组顺序已被该排序抹平；对已具有效 `seq` 的可信课程，先将 `order` 归一为 `seq` 才能让该 adapter 得到正确顺序。
- 同步会把归一后的场景 JSON 整体 POST 到云端：`lib/utils/cloud-sync.ts:40-45`、`156-169`，导入又无条件把云端数组的 `order`、`seq` 写成下标：`lib/utils/cloud-sync.ts:244-264`。旧客户端缓存再次保存时，服务端采用 `upsert(onConflict: id)`，没有 revision/ETag/冲突检测：`app/api/courses/route.ts:97-108`。所以“旧缓存冲突”不是 schema 不兼容，而是已存在的最后写入覆盖风险；写端归一会扩大一次覆盖所携带的字段变化。

**要求：** 明确迁移顺序为“未可信：恢复排序 → 原子写入 seq/order/trust；可信：校验唯一 seq 后写入”；并给云端保存增加版本或至少显式冲突策略。不能仅写“刷新 order”。

### 2. PR1 开关化：反对（若主张是 `saveStageToCloud` 只有一个入口）

**代码证据：**

- 自动保存入口确实只有生成 hook 的 `fireAndForgetAutoSave`：`lib/hooks/use-scene-generator.ts:55-80`，其中调用位于 `:72`。
- 但课堂页还有两个独立直接调用：顺序修复后立即重传，`app/classroom/[id]/page.tsx:277-284`；以及 Pro Mode 手动“保存到云端”按钮，`:701-717`（调用在 `:709`）。

因此，若环境开关包在 `saveStageToCloud` 函数内，关闭时会同时禁用手动保存和顺序修复回传，显然会影响其他文件/流程。只有将开关限定在 `fireAndForgetAutoSave` 调用点，主张才成立；此时它应命名为“自动保存开关”，而不是“云端保存开关”。

### 3. cherry-pick 顺序 `83fdecf3 → 1c507884 → 6d6e1ac8`：同意（但验收不足）

**代码证据：**

- Git 拓扑中 `1c507884` 的父提交就是 `83fdecf3`；`6d6e1ac8` 是该链上的祖先（`git merge-base 1c507884 6d6e1ac8` 返回 `6d6e1ac8`）。给出的顺序在拓扑上有效，且不会反向引入 DSL runtime 类型缺失。
- RuntimeStore 直接导入 `RUNTIME_DSL_VERSION`、`migrateRuntime`、`RuntimeSession` 等 Part A 导出的 DSL 符号：`1c507884:packages/@openmaic/storage/src/runtime/browser.ts:8-25`；所以 A 必须先于 B-runtime。
- DocumentStore 只依赖已有 DSL 文档类型与 `./types.js`：`6d6e1ac8:packages/@openmaic/storage/src/document/adapter.ts:10-12`，没有反向依赖 RuntimeStore。

冲突报告的“可应用”只证明补丁冲突少，不证明每个中间提交的构建、lint、包测试闭合。计划必须把每一提交后的 `pnpm` 类型检查和 `@openmaic/dsl`/`@openmaic/storage` 测试列为硬门；否则“顺序正确”仍可能在 monorepo CI 配置或导出面暴露问题。

### 4. Phase 4 的 31 文件、6 工作日估算：部分同意，整体偏乐观

**代码证据：**

- `chat-storage.ts` 仅 81 行，集中于 `chatSessions` 的替换式写、按 `createdAt` 读及删除（`lib/utils/chat-storage.ts:21-80`）；它适合 1–2 小时级别的初审。
- `stage-storage.ts` 有 459 行，不只是 stage/scenes：还耦合 chat、playback、quiz localStorage、缩略图媒体和 rename/list，见 `lib/utils/stage-storage.ts:126-129`、`240-259`、`359-432`。它不符合“每文件 1.5 小时”的平均复杂度假设。
- `audio-publish.ts` 有 809 行，并直接读取 `db.audioFiles` 后上传或重生成 TTS：`lib/audio/audio-publish.ts:396-458`、`502-590`。这同时涉及本地 blob 可用性、云端上传、TTS 失败语义与发布前校验，不能按普通存储适配器计时。
- 新 DocumentStore 自己默认使用独立数据库 `maic-documents`，而不是现有 Dexie：`6d6e1ac8:packages/@openmaic/storage/src/document/browser.ts:140-143`；其 `saveDocument` 是完整聚合写入并做 DSL 迁移/校验：`:210-249`。这会新增迁移、双读/回退和数据一致性测试，不在“31 个文件逐个 review”里。

因此 31 是合理的**盘点下限**，不是完成范围。6 天只够于接口盘点与低复杂度适配；若包含真实切流、旧数据迁移、回归和回退演练，则偏乐观。

### 5. 计划遗漏项：反对“已足够可实施”

以下项目在提供的计划摘要/冲突报告中没有被列为明确交付物：

1. **本地数据迁移和回退。** DocumentStore 是新的独立 IndexedDB；当前本地课程在 Dexie 的 `stages/scenes/stageOutlines` 中读取，`lib/utils/stage-storage.ts:141-230`。没有首次启动迁移、双读优先级、迁移幂等性和回退策略，切换后新库为空即会表现为本地课程消失。
2. **跨客户端覆盖控制。** 见第 1 项的 `cloud-sync.ts:156-169` 与 `app/api/courses/route.ts:97-108`。当前整课 JSON upsert 没有版本字段、条件更新或冲突反馈；自动保存、修复回传、手动保存及旧客户端均会竞争同一 `id`。
3. **删除语义的对齐。** 当前删除除了 Dexie stage/scenes/chat/playback，还清理按 sceneId 存放的 quiz localStorage：`lib/utils/stage-storage.ts:240-259`。DocumentStore 的 `deleteDocument` 只删除 document 聚合；若切流时未保留该清理编排，会留下学习/答题状态，或导致新旧状态不一致。
4. **schema 校验与 fork 扩展字段。** 上游 DocumentStore 在保存前校验 stage/scenes，并要求每个 scene 的 `stageId` 和有限数值 `order`：`6d6e1ac8:packages/@openmaic/storage/src/document/browser.ts:228-249`、`:80-97`。不能只验证 `sceneOrderTrusted`/`seq` 未被 strip；还必须用真实 RJ 场景（音频、PBL、移动端字段）跑 save/load，验证 DSL 宽化类型在迁移链下不被拒绝或误迁移。

## 对工时估算的修正意见

将“6 个工作日”拆开表达，避免把盘点和切流混为一项：

| 工作包 | 建议工时 |
| --- | ---: |
| 31 个引用点盘点、分类与低复杂度适配 | 4–6 人日 |
| stage/document 迁移、seq 回归、旧库双读/回退 | 4–6 人日 |
| chat/runtime 身份与删除语义适配 | 2–4 人日 |
| audio/media/blob 发布回归 | 3–5 人日 |
| Supabase 冲突策略、切流演练与端到端回归 | 3–5 人日 |
| **Phase 4 合计（含真实切流）** | **16–26 人日** |

如果 Phase 4 被严格限定为“仅审视、没有迁移或读写切换”，6 人日可以接受；一旦名称仍是“切流”，建议按 16–26 人日排期，并把数据迁移/回退和并发保存测试设为上线门槛。
