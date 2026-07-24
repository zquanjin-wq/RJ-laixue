# RJ-laixue Fork 扩展字段清单

> 维护者：研发协作  
> 最近更新：2026-07-24  
> 用途：Phase 1+2 cherry-pick 之前，盘点 RJ-laixue 在 DSL 类型系统之外加的所有字段。
> 配合金丝雀测试使用，**防止上游 strict validation 升级时静默丢失字段**。

---

## 字段清单

### Stage 扩展字段（DSL `Stage` 不知道的）

| 字段 | 类型 | 写入点 | 读取点 | 用途 | 引入 commit |
|---|---|---|---|---|---|
| `sceneOrderTrusted` | `boolean` | `lib/utils/database.ts:663-664` (v15 migration + repair 循环) | `lib/utils/cloud-sync.ts:41` (decide trust path) / `lib/utils/stage-storage.ts:162, 176, 177` / `lib/utils/database.ts:624, 661, 753` / `lib/store/stage.ts:169, 177, 438, 442, 457` / `app/classroom/[id]/page.tsx:192, 261` | 标记 stage 的 scene `seq` 字段是否可信（v15 migration 把它默认设 true） | 见 docs/diff-from-upstream.md（scene order 52 commits） |
| `sceneOrderRepairedAt` | `number` | 同上 | 同上 | scene order 修复时间戳（ops 调试用） | 同上 |
| `currentSceneId` | `string` | 见 `lib/store/stage.ts` | 见 `lib/store/stage.ts` | 用户在 classroom 里最后看的 scene id（playback 恢复用） | （classroom 早期） |
| `teacherVoiceConfig` | `{ providerId, voiceId, modelId }` | `app/generation-preview` 创建课程时 | 13 处引用（`lib/audio/audio-publish.ts` 多处 / `lib/teacher/apply-teacher-voice.ts` / `lib/hooks/use-discussion-tts.ts` / `lib/mobile/course-data.ts` / `lib/utils/cloud-sync.ts:92`） | 老师建课时指定的 TTS provider/voice/model（教师个性化） | （锐捷定制） |

### Scene 扩展字段（DSL `Scene` 不知道的）

| 字段 | 类型 | 写入点 | 读取点 | 用途 | 引入 commit |
|---|---|---|---|---|---|
| `seq` | `number` | `lib/utils/stage-storage.ts:85, 183`（保存时 `seq: index`） | `lib/utils/stage-storage.ts:152, 157, 366, 368`（trust 模式下 sort by seq） | scene 数组索引，作为 scene order trust 机制的可信排序键 | 同 scene order 52 commits |
| `narrationText` | `string` | 场景生成时 | `lib/audio/audio-publish.ts:323` | scene 整体旁白文本（区别于每个 action 的 text） | （锐捷定制） |
| `kind` | `string` | 场景生成时 | `lib/audio/audio-publish.ts:366` | scene 类型补充标识（DSL 已有 `type`，这个是更细粒度） | （锐捷定制） |
| `interactionType` | `string` | 场景生成时 | `lib/audio/audio-publish.ts:369` | 互动类型（影响 TTS 时机/方式） | （锐捷定制） |
| `name` | `string` | 场景生成时 | `lib/audio/audio-publish.ts:767` | DSL 用 `title`；RJ-laixue 多个 adapter 用 `name` 做 fallback | （锐捷定制） |

### AudioFileRecord 扩展字段（DSL 不知道的）

| 字段 | 类型 | 写入点 | 读取点 | 用途 | 引入 commit |
|---|---|---|---|---|---|
| `ossKey` | `string` | `lib/audio/audio-publish.ts` 等 | 同上 | CDN URL 缓存（避免重复拉 OSS） | （PR9 增强：补齐 audioUrl） |

### SceneRecord DB schema 扩展（IndexedDB / Supabase）

| 字段 | 类型 | 用途 |
|---|---|---|
| `seq` | `number` | 同上 Scene 扩展（DB schema 镜像） |

### StageRecord DB schema 扩展（IndexedDB / Supabase）

| 字段 | 类型 | 用途 |
|---|---|---|
| `sceneOrderTrusted` | `boolean` | 同上 Stage 扩展（DB schema 镜像） |
| `sceneOrderRepairedAt` | `number` | 同上 |
| `currentSceneId` | `string` | 同上 |
| `ossKey`（在 AudioFileRecord） | `string` | CDN 缓存 |

---

## 关键问题：83fdecf3 严格校验是 strip 还是 reject？

**实测答案**（来自 `docs/runtimestore-conflict-scan.md` §3.3）：

- **`validateStage` / `validateScene`** 只调用 `reqString` / `reqNumber` / `reqArray` 等已知字段检查函数
- **对未知字段既不 strip 也不 reject**——**静默通过**
- **`splitDocument`** 用 `{ ...doc.stage, [DSL_VERSION_KEY]: ... }` spread，**保留所有未识别字段**

**当前安全**：`sceneOrderTrusted` / `seq` / `teacherVoiceConfig` 等 RJ 扩展在 83fdecf3 引入的校验下**不会丢失**。

**但未来风险**：
- 上游可能升级校验为 `additionalProperties: false`（拒绝未知字段）
- 上游可能给 `splitDocument` 加 strip 逻辑
- 上游可能改 `SceneLike` 接口要求严格 shape

**防御措施**（Phase 1+2 落地项）：
1. **金丝雀测试**：构造一个带 RJ 扩展字段的 stage 过 validateStage + splitDocument + reassembleDocument，断言字段存活
2. **Phase 4 上游 schema migration** 时回头审视这 7 个字段，必要时正式注册进 DSL
3. **定期回归**：`fork-extensions.md` 跟代码一起 review，新增字段必须登记

---

## 退役条件

每个字段都标注了"用途"。**当用途消失时**，字段可以退役：

- `sceneOrderTrusted` / `sceneOrderRepairedAt` / `seq`：Phase 4 切到 DocumentStore 后，**写端归一**会让 `order` 自身变成可信的（信任机制收敛为"order 是否被修复过"），**这 3 个字段可退役**
- `currentSceneId`：如果未来 Zustand 持久化路径重构，可重新评估
- `teacherVoiceConfig` / `narrationText` / `kind` / `interactionType` / `name` / `ossKey`：纯 RJ 业务字段，无对应上游字段，**不会退役**

---

## 新增字段流程

当 RJ-laixue 添加新字段时：

1. **先检查 DSL 是否已经有该字段**（避免重复定义）
2. **登记进本文档**（带 commit hash）
3. **Phase 1+2 期间**：构造金丝雀测试断言新字段过 validateStage/validateScene 不丢
4. **Phase 4 期间**：评估是否纳入 DSL PR（推到上游 THU-MAIC/OpenMAIC）

---

## 关键事实速查

- **总数**：12 个 RJ-laixue 扩展字段（Stage 4 个 + Scene 5 个 + AudioFileRecord 1 个 + DB schema 镜像 2 个）
- **DSL 字段总数**：约 30 个（Stage 13 + Scene 10+ + SlideContent + Action + SpeechAction 等）
- **占比**：12 / 30 = 40% RJ 扩展（**很高**——但大部分是运行时属性，不进 schema）
- **DS 风险**：`sceneOrderTrusted` / `seq` / `teacherVoiceConfig` / `narrationText` / `kind` / `interactionType` / `name` 共 **7 个字段** 在 `splitDocument` + `reassembleDocument` 路径下需要存活

---

## 关联文档

- `docs/diff-from-upstream.md`：与 OpenMAIC v0.3.0 的完整差异
- `docs/runtimestore-conflict-scan.md`：Phase 1+2 cherry-pick 实测 + DSL 校验分析
- `docs/reports/2026-07-24-phase0.md`：Phase 0 报告（安全 commit 决策记录）
- `lib/utils/database.ts`：StageRecord / SceneRecord 类型定义
- `lib/utils/stage-storage.ts`：sceneOrderTrusted 业务实现
- `lib/audio/audio-publish.ts`：teacherVoiceConfig 业务实现
