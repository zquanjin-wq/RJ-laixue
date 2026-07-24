# RJ-laixue Fork 扩展字段清单（定稿：P1-b 后状态）

> 维护者：研发协作  
> 最近更新：2026-07-24  
> 用途：RJ-laixue 在 DSL 类型系统之外加的所有字段的**单一权威清单**。  
> 配套：`lib/dsl-extensions/registry.ts`（运行时注册）+ `tests/dsl/extensions-canary.test.ts`（金丝雀测试）。  
> 同步：每次字段增删必须同时更新本文件 + registry + 金丝雀测试 + PROJECT-STATE 决策记录。

---

## 字段分类总览

| 分类 | 数量 | 进云端 JSON | 注册到 RJ 扩展 |
|---|---|---|---|
| **cloudPersisted**（RJ 序列化）| 6 | ✅ | ✅ |
| **runtimeOnly**（strip 剥离）| 4 | ❌ | ✅ |
| **excluded**（不归 RJ）| 27+ | — | ❌ |

---

## cloudPersisted 字段（6 个）

| 字段 | 容器 | 类型 | 资产守卫 | 用途 |
|---|---|---|---|---|
| `teacherVoiceConfig` | Stage | `{ providerId, voiceId, modelId }` | — | 老师个性化音色 |
| `sceneOrderTrusted` | Stage | `boolean` | — | scene `seq` 字段是否可信（v15 migration） |
| `sceneOrderRepairedAt` | Stage | `number`（时间戳） | — | scene order 修复时间戳 |
| `currentSceneId` | Stage | `string \| null` | — | 学员最后看的 scene id（playback 恢复）|
| `data.imageMapping` | Stage.data | `Record<string, string>` | ✅ https only | PDF/PPT 内联图的 Storage URL |
| `narrationAudioUrl` | Scene | `string` | ✅ https only | scene 整体旁白音频 URL |

**资产守卫**：所有 `assetUrl=true` 字段值必须 `https://` 开头，检测到 `data:` URI 立即报错"检测到内联 base64 资产，请先上传至 Storage 后再保存"。  
**模式**：`NEXT_PUBLIC_DSL_ASSET_GUARD_MODE=warn`（默认）或 `error`（资产迁移完成后切换）。

---

## runtimeOnly 字段（4 个）

| 字段 | 容器 | 类型 | 用途 |
|---|---|---|---|
| `seq` | Scene | `number` | scene 数组索引（trust 模式下的可信排序键） |
| `narrationText` | Scene | `string` | scene 整体旁白文本（影响 TTS 时机）|
| `interactionType` | Scene | `string` | 互动类型（影响 TTS 时机/方式）|
| `ossKey` | audioFiles (Dexie) | `string` | CDN 缓存引用（本地表字段） |

**剥离规则**：在 `cloud-sync.ts` 上传序列化边界过 `stripRuntimeOnly()`，**深拷贝后剔除**，绝不原地修改（原地改会把运行时状态抹掉，播放立刻出 bug）。

---

## excluded 字段（不归 RJ）

### 上游 DSL 已声明（27 项）

`stage.whiteboard` / `stage.videoManifest` / `stage.agentIds` / `stage.languageDirective` / `stage.style` / `stage.outline` / `stage.data.outline` / `action.audioUrl` / ...（DSL 完整 schema 见 `packages/@openmaic/dsl/src/stage.ts` / `action.ts` / `slides.ts`）

### 派生运行时状态（11 项）

`quizResults` / `playbackState` / `chatResults` / `chatMessages` / `chats` / `mode` / ...

**为什么排除**：这些是 Zustand store / IndexedDB 表的运行时状态，不是 stage/scene 本体的文档内容。它们**不应该**进云端 JSON（无关数据）——**也不应该**注册到 DSL schema（不是文档模型字段）。

### 移动端视图字段

`MobileChapter.*` / `m-mode` / `m-currentChapterIndex`

**为什么排除**：移动端视图层的派生字段，从 stage 派生出，不是 stage 本体。

### Scene 别名（保留但不注册）

`scene.name`（DSL 用 title，RJ 多处 fallback 用 name）/ `scene.kind`（DSL type 已够用，RJ kind 冗余但保留以防下游依赖）

---

## 与 P1-a / DSL 扩展扫描报告的关系

P1-a 扫描报告 `docs/reports/2026-07-24-dsl-extension-scan.md` 列出 13 个 RJ 字段 + 11 个排除项，本文件是**定稿状态**——分类与 P1-a 扫描一致，但字段数从 13 收敛到 6+4 = 10 个（其余归入 excluded 不归 RJ 注册）。

P1-a 报告作为**扫描过程的考古记录**保留。

---

## 关键事实速查

- **DSL 字段总数**：约 30 个（Stage 13 + Scene 10+ + SlideContent + Action + SpeechAction 等）
- **RJ 扩展字段**：10 个（cloudPersisted 6 + runtimeOnly 4）
- **占比**：10 / 30 ≈ 33% RJ 扩展
- **DSL 校验对未知字段**：当前**静默通过**（不 strip 不 reject）——风险见 P1-b 报告
- **Phase 4 切流**：`@openmaic/storage` 的 BrowserDocumentStore 接管 stage 持久化时，RJ 扩展字段仍需存活——通过金丝雀测试（9/9）+ rebase 检查清单（PROJECT-STATE.md）保障

---

## 关联

- `lib/dsl-extensions/registry.ts` —— 注册清单（运行时 source of truth）
- `lib/dsl-extensions/validate.ts` —— 包装 validator + 资产守卫
- `lib/dsl-extensions/serialize.ts` —— stripRuntimeOnly 深拷贝剥离
- `tests/dsl/extensions-canary.test.ts` —— 9 个金丝雀测试
- `docs/reports/2026-07-24-p1-b.md` —— P1-b 完整报告
- `docs/reports/2026-07-24-dsl-extension-scan.md` —— P1-a 扫描原始报告
- `docs/PROJECT-STATE.md` —— rebase 检查清单