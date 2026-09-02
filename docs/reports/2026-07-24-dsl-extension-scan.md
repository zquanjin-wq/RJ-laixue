# DSL 扩展字段独立扫描（P1-a）

> 日期：2026-07-24  
> 任务卡：P1-a（只读扫描，零代码改动）  
> 输出：`docs/reports/2026-07-24-dsl-extension-scan.md`

## 摘要

**全库扫描结论**：RJ-laixue 在 DSL `Stage` / `Scene` / `Action` 之外**新增了 13 个字段**（不含派生视图）。其中 **3 个进云端 JSON 的 base64 资产字段** 是 P0-3 体积膨胀的根因——必须改造为 Storage 引用。

## 字段分类（按体积风险）

### 🔴 高风险：内联 base64 资产（待改造）

| 字段 | 容器 | 类型 | 体积（典型） | 来源 |
|---|---|---|---|---|
| `imageMapping` | Stage.data | `Record<string, string>`（`data:image/...;base64,...`） | 100KB × N 张图 | `lib/utils/image-storage.ts:86` 写入 |
| `audioBase64`（在 action.audioUrl） | Action | `data:audio/mp3;base64,...` URL | 50-200KB × N 个 speech | `lib/hooks/use-discussion-tts.ts:318` + `lib/audio/audio-publish.ts` 多处 |
| `narrationAudioUrl`（base64 形式） | Scene | `data:audio/mp3;base64,...` | 50-200KB | `lib/audio/audio-publish.ts:613` 写入 sceneRaw.narrationAudioUrl |

**改造方向**：全部改成 Supabase Storage 引用（URL 字符串），参考 §四。

### 🟡 中风险：RJ 扩展字段（运行时状态）

| 字段 | 容器 | 类型 | 进云端 | 用途 | 写入点 | 读取点 |
|---|---|---|---|---|---|---|
| `teacherVoiceConfig` | Stage | `{ providerId, voiceId, modelId }` | ✅ | 老师个性化音色 | `app/generation-preview` 创建课程时 | `lib/audio/audio-publish.ts:160-201` (3 处优先级链) / `lib/hooks/use-discussion-tts.ts:30,51,111,215,258` / `lib/utils/cloud-sync.ts:92,99` / `lib/mobile/course-data.ts:44,107,125` / `lib/teacher/apply-teacher-voice.ts` |
| `sceneOrderTrusted` | Stage | `boolean` | ✅ | scene `seq` 字段是否可信 | `lib/utils/database.ts:663-664` (v15 migration) / `lib/utils/stage-storage.ts:200-211` (repair 触发) | `lib/utils/cloud-sync.ts:41` / `lib/utils/stage-storage.ts:162, 176, 177` / `lib/store/stage.ts:183, 184` |
| `sceneOrderRepairedAt` | Stage | `number`（时间戳） | ✅ | scene order 修复时间 | 同上 | 同上 |
| `currentSceneId` | Stage | `string \| null` | ✅ | 用户最后看的 scene id（playback 恢复） | `lib/store/stage.ts:138, 155, 191, 213, 275, 287, 521` | `lib/action/engine.ts:297` / `lib/chat/agent-loop.ts:26` / `lib/edit/*` 多处 / `lib/orchestration/*` 多处 / `lib/store/stage.ts` 20+ 处 |
| `ossKey` | audioFiles / mediaFiles Dexie 表 | `string`（CDN URL） | ❌（只在本地 IndexedDB） | CDN 缓存引用 | `lib/utils/database.ts:110, 184`（schema 声明 + v7 migration） | （schema 字段，使用面较窄） |
| `seq` | Scene（IndexedDB + 内存） | `number` | ❌（Dexie schema 加，运行时内存） | scene 顺序信任键 | `lib/utils/stage-storage.ts:85, 183`（保存时 `seq: index`） | `lib/utils/stage-storage.ts:152, 157, 366, 368`（trust 模式下 sort by seq） |
| `narrationText` | Scene | `string` | ❌（不进 JSON） | scene 整体旁白文本 | （运行时 scene 生成时） | `lib/audio/audio-publish.ts:323-326` |
| `interactionType` | Scene | `string` | ❌（不进 JSON） | 互动类型（影响 TTS 时机） | （生成时） | `lib/audio/audio-publish.ts:369` |

### 🟢 低风险：核心业务字段（上游 DSL 已有）

| 字段 | 容器 | 备注 |
|---|---|---|
| `kind` | Scene | DSL `Scene.type` 已经够用——RJ `kind` 是冗余 |
| `name` | Scene | DSL 用 `title`——RJ `name` 是 fallback 别名（不冲突） |
| `audioUrl` | Action (speech) | 上游 DSL 已有字段——**不是 RJ 扩展**（之前 fork-extensions.md 误列）|

## 排除清单（看似扩展但不该注册）

| 候选 | 实际归属 | 理由 |
|---|---|---|
| `whiteboard` | Stage | DSL `Stage` 已声明（`Whiteboard[]` 类型） |
| `videoManifest` | Stage | DSL `Stage` 已声明 |
| `agentIds` | Stage | DSL `Stage` 已声明 |
| `languageDirective` | Stage | DSL `Stage` 已声明 |
| `style` | Stage | DSL `Stage` 已声明 |
| `whiteboard.shapes` | whiteboard 内部 | 上游 DSL 类型，不需注册 |
| `quizResults` | 运行时 store（Zustand） | 不是 stage/scene 本体，**不进 JSON**，**不应**注册到 DSL |
| `mode`（playback/edit/autonomous） | 运行时 store | 同上 |
| `chatResults` / `chatMessages` | 运行时 chat store | 同上 |
| `chats` | 运行时 store | 同上 |
| `playbackState` | 独立 IndexedDB 表 | 上游 schema，已有 `playbackState` 表 |

## P0-3 体积分布（输入参考）

| 字段类型 | 占比（典型 8 scene 课程） | 处理 |
|---|---|---|
| base64 音频 × 8 | 38% (~800KB) | ✅ 待改造为 Storage URL |
| base64 图片 × 8 | 19% (~400KB) | ✅ 待改造为 Storage URL |
| **剩余 43%（~870KB）** | scene.actions.text + DSL 必需字段 | 不动 |

资产外置后总 payload: **2.05 MB → 0.85 MB**（<1MB，安全区）。

## 改造建议（诊断后裁决，先不动手）

### 必须改造为 Storage URL（4.5MB 限制 + Phase 4 直传准备）

| 字段 | 新形态 | 备注 |
|---|---|---|
| `imageMapping`（Stage.data 内） | `Record<string, string>` → `Record<string, StorageRef>` | 改造为引用形态 |
| `audioUrl`（Action 内的 base64 形态） | `string` (CDN URL) | 已是字符串只需把 data: 改成 https: |
| `narrationAudioUrl`（Scene 内） | `string` (CDN URL) | 同上 |

### 设计原则（建议）

- **统一引用格式**：`{ kind: 'storage', ref: 'courses/{courseId}/audio/{audioId}.mp3' }` 或简化为纯 URL 字符串
- **回退机制**：网络失败时 fallback 到 IndexedDB blob（已有 `db.audioFiles`）
- **写端归一**：保存课程时把 base64 自动上传 + 替换为 URL

## 与 fork-extensions.md 的差异

之前 fork-extensions.md 列了 12 个字段（4 Stage + 5 Scene + 1 Audio + 2 DB 镜像）。**这次扫描差异**：

| 差异 | 解释 |
|---|---|
| `audioUrl` 误列在 RJ 扩展 | 上游 DSL 已有，**移除** |
| `whiteboard` 误列在 RJ 扩展 | 上游 DSL 已有，**移除** |
| 新增 `imageMapping` / `audioUrl base64 形态` / `narrationAudioUrl` | 实际是 P0-3 暴露的关键字段 |
| 新增 `quizResults` / `mode` / `chats` 到"排除清单" | 这些是运行时状态，**不是** DSL 扩展 |

## 待办

- [ ] **不修 schema / 不注册字段** —— 任务卡 P1-a 明确禁止
- [ ] Phase 1+2 启动前**独立裁决议定**：上面 4.1 / 4.2 / 4.3 的字段改造方案
- [ ] **决策输入**：fork-extensions.md 与本报告并列，作为裁决输入
- [ ] Phase 4 切流前**金丝雀测试**：构造带 `imageMapping` base64 / `audioUrl` base64 的 stage，过 DSL validator + splitDocument + reassembleDocument，**断言数据字段不被 strip**

## 关联

- `docs/fork-extensions.md` —— 之前的扩展字段清单（待按本报告合并更新）
- `docs/PROJECT-STATE.md` —— 操作规约
- `docs/reports/2026-07-24-p0-3-413.md` —— 体积分布来源
- `scripts/analyze-classroom-payload-bytes.js` —— 体积模拟脚本