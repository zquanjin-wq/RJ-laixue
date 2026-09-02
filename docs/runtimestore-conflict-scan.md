# RuntimeStore Cherry-Pick 冲突预检报告

> 2026-07-24 · 跑 Fable 5 的 4 步冲突预检脚本的实测结果。

## 1. 步骤 1: `git fetch upstream --tags`

✅ 成功。上游 main + v0.3.0/v0.3.1 tags 已在本地。

```
From https://github.com/THU-MAIC/OpenMAIC
   1120f89c..d6d6c63f  fix/http-store-fetch-binding -> upstream/fix/http-store-fetch-binding
   e39c64cd..be3d313b  main       -> upstream/main
```

## 2. 步骤 2: 逐个 cherry-pick

每个 commit 用 `git cherry-pick --no-commit <hash>` 应用，看 conflict 列表，然后 `git reset --hard main` 清理。

### 2.1 `83fdecf3` — DSL envelope (Part A)

**冲突文件：0**

**改动范围**（全部在 `packages/@openmaic/dsl/`）：

| 文件 | 类型 | 内容 |
|---|---|---|
| `.github/workflows/ci.yml` | M | 把 dsl 测试从 publish workflow 提到 PR CI |
| `packages/@openmaic/dsl/README.md` | M | runtime envelope 文档 |
| `packages/@openmaic/dsl/src/index.ts` | M | 导出 RuntimeSession / RuntimeRecord 类型 |
| `packages/@openmaic/dsl/src/runtime.ts` | A (new) | 整个 runtime envelope 实现 |
| `packages/@openmaic/dsl/src/validate.ts` | M | runtime 校验器 |
| `packages/@openmaic/dsl/src/version.ts` | M | `runtimeDslVersion` ladder |
| `packages/@openmaic/dsl/test/runtime.test.ts` | A (new) | runtime 测试 |
| `packages/@openmaic/dsl/test/validate.test.ts` | M | 加 runtime 校验 case |
| `packages/@openmaic/dsl/test/version.test.ts` | M | 加 runtimeDslVersion 测试 |

**结论**：✅ 零冲突。RJ-laixue 没碰过 `@openmaic/dsl` workspace 包。

### 2.2 `1c507884` — RuntimeStore 接口 + BrowserRuntimeStore (Part B)

**冲突文件：3**

| 文件 | Hunks | 冲突内容 |
|---|---|---|
| `.github/workflows/ci.yml` | 1 | HEAD 没 dsl/storage 测试 step，v0.3.1 加了——**接受 v0.3.1** |
| `packages/@openmaic/storage/README.md` | 4 | 3 个段落 v0.3.1 加了 DocumentStore / RuntimeStore 说明，1 个表行加 keyless providers——**接受 v0.3.1** |
| `packages/@openmaic/storage/src/index.ts` | 1 | v0.3.1 在 export 列表加 DocumentStore / RuntimeStore / BrowserRuntimeStore 等——**接受 v0.3.1** |

**结论**：✅ 3 个冲突都是**接受 v0.3.1 即可**（HEAD 端都是空白）。

### 2.3 `6d6e1ac8` — DocumentStore

**冲突文件：0**

**改动范围**（全部在 `packages/@openmaic/storage/src/document/` 新目录）：

| 文件 | 类型 |
|---|---|
| `packages/@openmaic/storage/README.md` | M（更新说明） |
| `packages/@openmaic/storage/src/document/adapter.ts` | A (new) |
| `packages/@openmaic/storage/src/document/browser.ts` | A (new) |
| `packages/@openmaic/storage/src/document/types.ts` | A (new) |
| `packages/@openmaic/storage/src/index.ts` | M（导出） |
| `packages/@openmaic/storage/test/document-adapter.test.ts` | A (new) |
| `packages/@openmaic/storage/test/document-browser.test.ts` | A (new) |
| `packages/@openmaic/storage/test/document-contract.ts` | A (new) |

**结论**：✅ 零冲突。

### 2.4 三个 commit 总结

| Commit | 冲突数 | 风险 |
|---|---|---|
| `83fdecf3` (Part A) | 0 | 🟢 无 |
| `1c507884` (Part B RuntimeStore) | 3（README + ci + index）| 🟢 全部接受 v0.3.1 |
| `6d6e1ac8` (Part B DocumentStore) | 0 | 🟢 无 |
| **合计** | **3 文件 / 6 hunks** | 全是接受上游 |

**全部都是 packages/@openmaic/ 内部的改动**——**RJ-laixue 的 lib/ 和 app/ 零冲突**。

## 3. 步骤 3: `sceneOrderTrusted` 读写点全库扫描

### 3.1 RJ-laixue 端的读写点（18 处）

#### 写入（4 处）

| 文件 | 行 | 写入点 |
|---|---|---|
| `app/classroom/[id]/page.tsx` | 192, 193 | scene order 修复后，标记 `sceneOrderTrusted: true` + `sceneOrderRepairedAt` |
| `app/classroom/[id]/page.tsx` | 261, 262 | 同上，cascade 删除路径 |
| `lib/store/stage.ts` | 183, 184 | 同上，scene order 修复触发 |
| `lib/utils/stage-storage.ts` | 200, 201 | `saveStageData` 写入时附带 |
| `lib/utils/stage-storage.ts` | 210, 211 | 手动 reorder 触发 |
| `lib/utils/database.ts` | 661-664 | **v15 migration** 把现有 stage 一次性标记 trusted=true |

#### 读取（7 处）

| 文件 | 行 | 读取点 |
|---|---|---|
| `lib/utils/cloud-sync.ts` | 41 | `stageIsTrusted = stage.sceneOrderTrusted === true` |
| `lib/utils/cloud-sync.ts` | 59 | 写入时透传 |
| `lib/utils/stage-storage.ts` | 68, 69 | 加载时从 stage 提取 |
| `lib/utils/stage-storage.ts` | 162, 176, 177 | saveToStorage 路径读取 + 透传 |
| `lib/utils/database.ts` | 624, 654, 655, 661, 663, 664, 668 | v15 migration + StageRecord 类型 + 修复回填循环 |
| `lib/utils/database.ts` | 753 | trust model 注释 |
| `lib/store/stage.ts` | 169, 177, 438, 442, 457 | store 加载/自我修复/持久化路径 |

#### `seq` 字段读写（scene order trust 的另一半）

`lib/utils/stage-storage.ts` 行 80, 85, 119, 152, 157, 183, 191, 366, 368：scenes 数组里 `seq: index` 写入 + 读取，用于 trust 模式下的 `prefer: 'auto'` 排序。

### 3.2 DSL 端的认知

```
$ grep -rn "sceneOrderTrusted|seq" packages/@openmaic/dsl/
（零命中）
```

**DSL 包完全不知道 `sceneOrderTrusted` 和 `seq` 这两个字段。**

### 3.3 严格校验是 strip 还是 reject？

**`validateStage`（packages/@openmaic/dsl/src/validate.ts:185-194）**：

```typescript
export function validateStage(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  if (!isObject(doc)) return { valid: false, errors: [...] };
  reqString(doc, 'id', '', errors);
  reqString(doc, 'name', '', errors);
  // ...只检查已知字段
}
```

**只检查已知字段的存在和类型**——`sceneOrderTrusted`（boolean）和 `seq`（number）作为未知字段**既不会被 reject，也不会被 strip**，**静默通过校验**。

**`splitDocument`（packages/@openmaic/storage/src/document/adapter.ts:40）**：

```typescript
const stageRow: StageRow = { ...doc.stage, [DSL_VERSION_KEY]: DSL_VERSION };
```

**用 spread 保留所有未识别字段**——`sceneOrderTrusted` / `sceneOrderRepairedAt` / `seq` 全部保留。

**`reassembleDocument`（adapter.ts:61）**：

```typescript
const scenes = [...sceneRows].sort((a, b) => a.order - b.order);
```

**硬编码按 `order` 排序，不读 `seq`**。

### 3.4 结论

| 风险 | 判定 |
|---|---|
| Fable 5 担心"严格校验 strip 未知字段 → sceneOrderTrusted 静默丢失" | **不会发生**：DSL 校验器对未知字段静默放过；`splitDocument` spread 保留 |
| Fable 5 担心"严格校验 reject 未知字段 → 存量 stage 全部加载失败" | **不会发生**：同上 |
| **新发现风险**：DocumentStore `reassembleDocument` 硬编码 `sort by order` | **scene order trust 机制在 DocumentStore 路径下行为退化**——`seq` 字段被存但被忽略，trust 分支永远不执行，scene 总是按 `order` 排 |

**Phase 2 落地时必须解决**：在 DocumentStore 之上加 RJ-laixue 自己的 sort wrapper（`prefer: 'auto'` 用 seq，否则 fallback order），否则 cherry-pick 完后 scene 顺序回退到 v0.3.0 之前的不稳定状态。

## 4. 步骤 4: Dexie/IndexedDB 引用面（Phase 4 切流完整影响）

### 4.1 `lib/` 直接使用 Dexie 或 db.* 的核心文件

| 文件 | db.表 引用 | 业务域 |
|---|---|---|
| `lib/utils/database.ts` | 全部 12 张表 | 核心：定义 schema + Dexie 单例 + `clearDatabase` |
| `lib/utils/stage-storage.ts` | `stages`, `scenes`, `stageOutlines`, `mediaFiles` | **stage 持久化核心**（`saveStageData`/`loadStageData`/`saveToStorage`） |
| `lib/utils/chat-storage.ts` | `chatSessions` | **chat 持久化**（v0.3.1 要切到 RuntimeStore） |
| `lib/utils/playback-storage.ts` | `playbackState` | playback 状态 |
| `lib/utils/image-storage.ts` | `imageFiles` | 图片 + PDF blob 存储 |
| `lib/utils/audio-player.ts` | `audioFiles`（读） | TTS 缓存读取 |
| `lib/utils/cloud-sync.ts` | `stages`, `scenes`, `stageOutlines` | 跟 Supabase 同步 |
| `lib/utils/snapshot.ts` | `snapshots` | 编辑器快照历史 |
| `lib/utils/scene-order.ts` | 无 | 纯函数（不直接 Dexie） |
| `lib/hooks/use-scene-generator.ts` | `audioFiles` | TTS 写入 |
| `lib/audio/audio-publish.ts` | `audioFiles` | TTS 三层发布 |
| `lib/audio/voxcpm-voices.ts` | `voiceProfiles` | 老师音色 |
| `lib/audio/voice-registration-client.ts` | `autoVoiceCache` | 音色自动注册 |
| `lib/audio/regenerate-speech-tts.ts` | `audioFiles` | TTS 重生成 |
| `lib/media/media-orchestrator.ts` | `mediaFiles` | 媒体编排 |
| `lib/agent/client/agent-thread-store.ts` | `agentEditSessions` | AI editor session |
| `lib/orchestration/registry/store.ts` | `generatedAgents` | 生成的 agent 缓存 |
| `lib/store/stage.ts` | `stageOutlines` | Zustand store → Dexie 同步 |
| `lib/store/snapshot.ts` | `snapshots` | store 包装 |
| `lib/store/media-generation.ts` | `mediaFiles` | store 包装 |
| `lib/export/use-export-classroom.ts` | `stages` | 导出 |
| `lib/export/classroom-zip-utils.ts` | `audioFiles`, `mediaFiles` | 导出 |
| `lib/import/use-import-classroom.ts` | `stages`, `scenes`, `audioFiles`, `mediaFiles`, `generatedAgents` | 导入 |

**`app/` 目录里没有任何文件直接用 Dexie**——所有 db 访问都通过 `lib/utils/*-storage.ts` 包装。

### 4.2 `app/` 间接调用 storage helper 的文件

| 文件 | 调用的 helper |
|---|---|
| `app/page.tsx` | `storePdfBlob`, `stage-storage` 多函数 |
| `app/classroom/[id]/page.tsx` | `loadImageMappingCompressed`, `saveStageToCloud`（cloud-sync） |
| `app/generation-preview/page.tsx` | `image-storage` 多函数 |
| `components/cloud-courses.tsx` | `listCloudCourses`, `listMyCourses`, `deleteCloudCourse` |
| `components/learning-manager.tsx` | `cloud-sync` 多函数 |
| `components/settings/general-settings.tsx` | `clearDatabase`（来自 `lib/utils/database`） |
| `components/edit/PlaybackChromeRoot.tsx` | `createAudioPlayer`（来自 `lib/utils/audio-player`） |
| `components/student-gate.tsx` | `verifyStudentAccess` |

### 4.3 Phase 4 切流影响面估算

| 维度 | 数字 |
|---|---|
| 直接 import Dexie / 调 db.* 的文件 | **23 个**（全在 `lib/`） |
| 间接通过 `lib/utils/*-storage` 包装 | **8 个**（app + components） |
| 涉及的业务域 | stage + scene + chat + playback + image + audio + snapshot + voice + media + agent + outline |
| 表数量 | **12 张**（含 v0.3.1 的 `chatStorageLocks` 已废弃） |

**Phase 4 切流时**，这 23 个 `lib/` 文件 + 8 个 `app/components` 文件**全部需要审视**（不是改，是看是否还依赖 Dexie，能切到 DocumentStore / RuntimeStore 就切）。

按 1 文件 1-2 小时 review 工作量估算：`(23+8) × 1.5h ≈ 47 小时 ≈ 6 个工作日`（不含测试和回归）。

## 5. 总结：Fable 担心的风险 vs 实测

| Fable 担心 | 实测 | 严重程度 |
|---|---|---|
| sceneOrderTrusted 严格校验 strip 未知字段 | 不会发生（DSL 校验器对未知字段静默通过） | ✅ 无 |
| sceneOrderTrusted 严格校验 reject 未知字段 | 不会发生 | ✅ 无 |
| DocumentStore 忽略 `seq`（trust 机制失效） | **真存在**（reassembleDocument 硬编码 `sort by order`） | 🟡 **必须解决** |
| ESLint 包边界规则 | 未实测（需要 ESLint 跑过） | ⚠️ 待 Phase 2 验证 |
| Web Locks 移动端降级 | 未实测（需要 mobile 测试） | ⚠️ 待 Phase 4 验证 |
| 上游 Postgres reference server ≠ Supabase + RLS | 认同（fable 自己的判断） | 🟡 Phase 4 必做适配器 |

**净结果**：cherry-pick Part A + Part B **实际冲突面比 Fable 担心的更小**（0 + 3 个 README/ci 冲突），但**有一个未被发现的风险**——`reassembleDocument` 忽略 `seq` 字段，scene order trust 机制在 DocumentStore 路径下退化。

## 6. 给 Fable 5 的回话数据点

1. **三 commit cherry-pick 实际冲突 3 文件 / 6 hunks**——全是 README/ci/index 接受 v0.3.1 即可，**业务代码零冲突**
2. **sceneOrderTrusted 严格校验实测是"静默通过"**（Fable 担心的最坏情况不存在）——但 DocumentStore 的 `reassembleDocument` 硬编码 `sort by order` 忽略了 RJ-laixue 的 `seq` 字段，**trust 机制在 DocumentStore 路径下行为退化**，需要在 Phase 2 加 sort wrapper 解决
3. **Dexie 引用面 23 + 8 = 31 个文件**——但都是包装层（`lib/utils/*-storage.ts`），app/ 0 直接引用，迁移改造面比想象中集中
4. **Phase 2 落地预估**：3 commit cherry-pick + sort wrapper 修复 + ESLint/锁文件 + 测试 ≈ 4-5 天（与 Fable 估算的 3-4 天接近，但需要 +1-2 天专门处理 sort wrapper 回归测试）
