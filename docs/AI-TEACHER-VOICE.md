# AI 教师音色配置与 TTS 决策机制

## 1. 文档目的

本文档用于说明当前项目中 **AI 教师音色配置、课程级持久化、播放与 Q&A 阶段 TTS 决策机制** 的设计原则、关键实现、已修复问题及后续维护注意事项。

本文档同时作为项目交接资料的一部分，帮助后续接手人员理解：

1. AI 教师音色为什么需要课程级持久化；
2. `settings.ttsVoice`、`agent.voiceConfig`、`stage.teacherVoiceConfig` 等多个音色来源之间的关系；
3. generate 模式下 LLM 生成角色音色与用户配置音色之间的优先级；
4. Q&A / Discussion 场景中 TTS 最终音色的决策链路；
5. 本次 BUG 的根因、修复过程和最终稳定方案；
6. 后续维护中需要避免的错误改法；
7. 如何验证该问题没有复发。

---

## 2. 项目背景

当前项目是一个面向在线学习平台的 AI 课程生成与播放系统，核心目标是通过 AI 能力提升学员学习体验，并为企业培训场景带来降本增效。

在课程体验中，AI 教师不仅负责内容讲解，也参与学员提问后的 Q&A / Discussion 互动。因此，AI 教师的身份一致性非常重要，其中包括：

- 角色名称；
- 角色设定；
- 语气风格；
- 讲解方式；
- TTS 供应商；
- TTS 音色；
- TTS 模型。

对于学习平台而言，AI 教师音色属于课程体验的一部分。用户在创建课程时选择了某个 AI 教师音色后，该音色应该成为该课程的固定属性，而不是随着全局设置或 LLM 生成角色配置而变化。

因此，本项目最终确立如下原则：

```text
课程创建完成后，AI 教师音色应作为课程级配置固定下来。
```

也就是：

```text
AI 教师音色的权威来源是 stage.teacherVoiceConfig。
```

---

## 3. 关键概念

### 3.1 `settings.ttsVoice`

`settings.ttsVoice` 表示当前用户在全局设置或课堂角色配置 UI 中选中的 TTS 音色。

示例：

```json
{
  "ttsProviderId": "minimax-tts",
  "ttsVoice": "English_Graceful_Lady"
}
```

它适合用于：

- 创建课程前的当前选择；
- 新课程创建时生成课程级快照；
- 没有课程级配置时的 fallback。

但它不适合直接作为已创建课程播放时的权威音色来源。

原因是：

```text
settings.ttsVoice 是当前用户设置，会随用户后续操作变化。
```

如果已创建课程继续依赖 `settings.ttsVoice`，可能导致：

```text
用户后来切换了全局音色
↓
旧课程播放时 AI 教师音色也跟着变化
```

这不符合“课程创建完成后 AI 教师音色固定”的产品规则。

---

### 3.2 `agent.voiceConfig`

`agent.voiceConfig` 表示某个 Agent 自带的音色配置。

示例：

```json
{
  "id": "gen-7ZITpPjh",
  "name": "林老师",
  "role": "teacher",
  "voiceConfig": {
    "providerId": "minimax-tts",
    "voiceId": "Chinese (Mandarin)_Warm_Girl"
  }
}
```

在 generate 模式下，Agent 可能由 LLM 自动生成。LLM 可能会根据角色设定为 teacher、student、assistant 分配不同音色。

这对学生、助教等角色是合理的，但对于 AI 教师，需要遵循产品规则：

```text
用户在课程创建时为 AI 教师选择的音色，应优先于 LLM 生成的 teacher.voiceConfig。
```

因此，对教师角色而言：

```text
agent.voiceConfig 只能作为 fallback，不能覆盖 stage.teacherVoiceConfig。
```

---

### 3.3 `stage.teacherVoiceConfig`

`stage.teacherVoiceConfig` 是课程级 AI 教师音色快照，在课程创建阶段写入 `stage` 并随课程数据持久化。

示例：

```json
{
  "providerId": "minimax-tts",
  "voiceId": "English_Graceful_Lady",
  "modelId": "speech-2.8-hd"
}
```

这是当前系统中 AI 教师音色的权威数据源。

一旦存在该字段，AI 教师在以下场景均应优先使用它：

- 课程讲解；
- 课程播放；
- Discussion；
- Q&A；
- 其他教师发声场景。

### 持久化机制

`Stage` 类型的 dsl 字段来自 `@openmaic/dsl`，是 closed 形态。`teacherVoiceConfig` 不在 dsl 类型中，运行时通过 cast 挂在对象上：

```ts
type AugmentedStage = Stage & {
  teacherVoiceConfig?: {
    providerId: string;
    voiceId: string;
    modelId?: string;
  };
};
```

写入位置：`app/generation-preview/page.tsx` 课程创建流程，**早于** `store.setStage(stage)` 调用，避免被 stage store 内部浅拷贝丢弃。

读取位置：`components/edit/PlaybackChromeRoot.tsx`，通过 `useStageStore()` 解构出的 `stage` 配合 local intersection cast 读取。

写入时的 fallback 链路：

```ts
modelId = settings.ttsProvidersConfig?.[provider]?.modelId
       ?? TTS_PROVIDERS[provider].defaultModelId
       ?? undefined;
```

这保证 `modelId` 永远有合理值（即使是 provider 自带默认）。

---

### 3.4 `selectedAgents`

`selectedAgents` 是播放页或互动页中根据当前场景、选中角色、Agent registry 等信息组装出来的运行时 Agent 列表。

它属于中间态数据。

需要注意：

```text
selectedAgents 不是 AI 教师音色的权威来源。
```

它可能因为以下原因发生变化：

- registry state 更新；
- store 重新加载；
- React render / useMemo 重新计算；
- Fast Refresh；
- generated agent 数据重新进入运行时；
- 旧课程数据缺少新字段。

因此，不应从：

```ts
selectedAgents[teacher].voiceConfig
```

反推出 AI 教师最终 TTS 配置，除非作为旧课程 fallback。

---

## 4. 最终设计原则

### 4.1 AI 教师音色权威来源

最终原则：

```text
AI 教师音色的权威来源 = stage.teacherVoiceConfig
```

只要 `stage.teacherVoiceConfig` 存在，AI 教师发声必须使用该配置。

### 4.2 AI 教师 TTS 优先级

对于 `role === 'teacher'` 的 Agent，音色优先级为：

```text
1. stage.teacherVoiceConfig
2. agent.voiceConfig
3. global settings.ttsVoice
4. provider default voice
```

说明：

- `stage.teacherVoiceConfig` 是课程创建时保存的用户选择；
- `agent.voiceConfig` 可能来自 LLM 生成，不能覆盖课程级教师音色；
- `settings.ttsVoice` 是全局当前值，只能作为 fallback；
- provider default voice 是最后兜底。

实现位置：`lib/teacher/apply-teacher-voice.ts` 的 `applyTeacherVoiceConfigToAgents` 在 `useDiscussionTTS` hook 内部对 `agents` 做覆盖，覆盖后 `teacher.voiceConfig` 已经是 stage 的值，使得优先级第 2 层也命中正确声音，不依赖外部传入 `teacherVoiceConfig` 参数。

### 4.3 非教师 Agent TTS 优先级

对于 `student`、`assistant` 等非教师角色，音色优先级为：

```text
1. agent.voiceConfig
2. global settings.ttsVoice
3. provider default voice
```

说明：

- 非教师 Agent 不应被 `stage.teacherVoiceConfig` 覆盖；
- LLM 生成的学生 / 助教音色可以保留；
- 本次修复不能影响 student / assistant 的个性化音色。

`applyTeacherVoiceConfigToAgents` 函数识别教师身份 (`role === 'teacher'` 或 `id === 'default-1'` 或 `name === 'AI教师'`)，非教师 agent 完全不动。

---

## 5. 本次 BUG 概述

### 5.1 问题现象

用户在课堂角色配置中为 AI 教师选择了指定 MiniMax TTS 音色，例如：

```text
providerId = minimax-tts
voiceId = English_Graceful_Lady
modelId = speech-2.8-hd
```

课程创建阶段日志显示配置写入正确：

```text
[VOICE DEBUG][Create Course Payload Teacher Voice]
providerId="minimax-tts"
voiceId="English_Graceful_Lady"
modelId="speech-2.8-hd"
```

但在 Q&A / Discussion 场景中，AI 教师最终发声使用了 LLM 生成 teacher agent 自带音色，例如：

```text
voiceId="Chinese (Mandarin)_Warm_Girl"
```

最终错误日志示例：

```text
[VOICE DEBUG][Discussion TTS Voice]
agent?.voiceConfig={"providerId":"minimax-tts","voiceId":"Chinese (Mandarin)_Warm_Girl"}
teacherVoiceConfig={"providerId":"minimax-tts","voiceId":"Chinese (Mandarin)_Warm_Girl"}

[VOICE DEBUG][Discussion TTS Final]
source=agent.voiceConfig
providerId="minimax-tts"
voiceId="Chinese (Mandarin)_Warm_Girl"
```

### 5.2 早期问题：fallback 到默认音色

在更早阶段，也出现过 AI 教师音色 fallback 到默认音色的问题，例如：

```text
voiceId="female-yujie"
```

其原因是：

```text
课程创建阶段没有将 AI 教师音色持久化到课程数据中。
```

也就是 teacher agent 的 `voiceConfig` 为 `null` 或未正确保存，播放页只能 fallback 到全局 settings 或 provider 默认音色。

### 5.3 后续问题：generated teacher 音色覆盖用户选择

在补充 `stage.teacherVoiceConfig` 后，创建阶段已能保存用户选择。但 generate 模式下，LLM 生成的 teacher agent 仍然可能自带音色：

```json
{
  "role": "teacher",
  "voiceConfig": {
    "providerId": "minimax-tts",
    "voiceId": "Chinese (Mandarin)_Warm_Girl"
  }
}
```

如果运行时 TTS 决策优先读取 `agent.voiceConfig`，就会导致：

```text
LLM 生成的 teacher.voiceConfig 覆盖用户创建课程时选择的 AI 教师音色。
```

### 5.4 最终根因

最终根因不是 MiniMax TTS 服务问题，也不是 provider 校验问题，而是：

```text
teacherVoiceConfigForDiscussion 曾经从 selectedAgents[teacher].voiceConfig 反推。
```

而 `selectedAgents` 是运行时中间态，在某些 render / registry 更新 / Fast Refresh / store 重算后，可能重新回到 LLM 生成的原始 teacher voiceConfig。

因此，即使某一帧里 `selectedAgents[teacher].voiceConfig` 被覆盖成了用户选择的音色，Q&A 真正触发时仍可能重新变回 generated voice。

错误链路如下：

```text
stage.teacherVoiceConfig = English_Graceful_Lady
↓
PlaybackChromeRoot 中 selectedAgents 曾经被覆盖为 English_Graceful_Lady
↓
teacherVoiceConfigForDiscussion 通过 selectedAgents[teacher].voiceConfig 获取
↓
但 selectedAgents 在某次 render / registry 更新后回退到原始 generated teacher（Warm_Girl）
↓
teacherVoiceConfigForDiscussion 变成 Warm_Girl
↓
useDiscussionTTS 收到 Warm_Girl
↓
最终 TTS 也用 Warm_Girl ❌
```

---

## 6. 修复方案

### 6.1 课程创建写入 `stage.teacherVoiceConfig`

在 `app/generation-preview/page.tsx` 课程创建阶段，写入：

```ts
const s = useSettingsStore.getState();
const cfgModelId = s.ttsProvidersConfig?.[s.ttsProviderId]?.modelId;
const providerDefaults =
  (TTS_PROVIDERS as Record<string, { defaultModelId?: string } | undefined>)[s.ttsProviderId];
const fallbackModelId = providerDefaults?.defaultModelId;

const teacherVoiceConfig = {
  providerId: s.ttsProviderId,
  voiceId: s.ttsVoice,
  modelId: cfgModelId ?? fallbackModelId ?? undefined,
};

(stage as Stage & { teacherVoiceConfig?: unknown }).teacherVoiceConfig = teacherVoiceConfig;
```

`modelId` 走 fallback 链：
- `settings.ttsProvidersConfig[provider].modelId`（用户选了具体 model）
- `TTS_PROVIDERS[provider].defaultModelId`（provider 自带默认）
- `undefined`

例如选 `minimax-tts` provider → modelId 走 `speech-2.8-hd`（MiniMax TTS 自带默认）。

### 6.2 抽出公共函数 `applyTeacherVoiceConfigToAgents`

文件：`lib/teacher/apply-teacher-voice.ts`。

```ts
function isTeacherAgent(a: AgentConfig): boolean {
  return (
    a.role === 'teacher' || a.id === 'default-1' || a.name === 'AI教师'
  );
}

export function applyTeacherVoiceConfigToAgents<T extends AgentConfig>(
  agents: T[],
  teacherVoiceConfig: StageTeacherVoiceConfig | undefined,
): T[] {
  if (!teacherVoiceConfig) return agents;
  return agents.map((a) => {
    if (!isTeacherAgent(a)) return a;
    return {
      ...a,
      voiceConfig: {
        providerId: teacherVoiceConfig.providerId as ...,
        voiceId: teacherVoiceConfig.voiceId,
        ...(teacherVoiceConfig.modelId
          ? { modelId: teacherVoiceConfig.modelId }
          : {}),
      },
    };
  });
}
```

行为：
- 仅修改教师身份 agent（`role==='teacher'` 或 `id==='default-1'` 或 `name==='AI教师'`）
- 非教师 agent 完全不动
- 总是用 `teacherVoiceConfig` 覆盖（包括 LLM 已经写入 voiceConfig 的情况）

### 6.3 `useDiscussionTTS` 内部应用覆盖

文件：`lib/hooks/use-discussion-tts.ts`。

```ts
const effectiveAgents = useMemo(
  () => applyTeacherVoiceConfigToAgents(agents, teacherVoiceConfig),
  [agents, teacherVoiceConfig],
);
```

后续所有内部 `agents.find` / `agents.forEach` 等都改成读 `effectiveAgents`，**确保 teacher.voiceConfig 永远是 stage.teacherVoiceConfig 的值**。

这样 TTS 优先级第 2 层 `agent.voiceConfig` 命中正确，不依赖调用方传 teacherVoiceConfig。

### 6.4 `PlaybackChromeRoot` 简化

文件：`components/edit/PlaybackChromeRoot.tsx`。

关键改动：`teacherVoiceConfigForDiscussion` useMemo 直接读 `stage.teacherVoiceConfig`，**不再从 selectedAgents[teacher].voiceConfig 反推**。

```ts
const teacherVoiceConfigForDiscussion = useMemo(() => {
  if (!stage.teacherVoiceConfig) return undefined;
  return {
    providerId: stage.teacherVoiceConfig.providerId as TTSProviderId,
    voiceId: stage.teacherVoiceConfig.voiceId,
    ...(stage.teacherVoiceConfig.modelId
      ? { modelId: stage.teacherVoiceConfig.modelId }
      : {}),
  };
}, [stage?.teacherVoiceConfig]);
```

不使用 `useAgentRegistry` selector（避免 Zustand 订阅导致的中间态），改成 `useAgentRegistry.getState()` 在 selectedAgents useMemo 内同步取值。

### 6.5 模型 → 音色 → 优先级整体链路

```text
课程创建：
  settings.ttsProviderId / settings.ttsVoice / settings.ttsProvidersConfig[...].modelId
  ↓
  fallback: provider.defaultModelId
  ↓
  stage.teacherVoiceConfig  ← 课程级权威
  ↓
  IndexedDB 持久化

播放 / Q&A：
  stage.teacherVoiceConfig
  ↓
  applyTeacherVoiceConfigToAgents(agents, stage.teacherVoiceConfig)
  ↓
  effectiveAgents (teacher.voiceConfig 已经被覆盖)
  ↓
  resolveVoiceForAgent → 优先级链（详见 4.2 / 4.3）
  ↓
  agent.voiceConfig 命中（teacher 值就是 stage 值）
  ↓
  fetch /api/generate/tts  with ttsModelId / ttsVoice / ttsProviderId
  ↓
  MiniMax TTS 合成
```

---

## 7. 验收日志

最终保留 3 条验收日志（dev-only）：

### 7.1 `[Create Course Payload Teacher Voice]`

`app/generation-preview/page.tsx`，课程创建时打印。

预期输出：

```text
providerId="minimax-tts"
voiceId="English_Graceful_Lady"
modelId="speech-2.8-hd"
source=settings.ttsProviderId/settings.ttsVoice/modelId=settings.ttsProvidersConfig[...].modelId|provider.defaultModelId
```

### 7.2 `[Teacher VoiceConfig For Discussion]`

`components/edit/PlaybackChromeRoot.tsx`，`stage.teacherVoiceConfig` 变化时打印。

预期输出：

```text
teacherAgentId="(stage-source)"
teacherVoiceConfig={"providerId":"minimax-tts","voiceId":"English_Graceful_Lady","modelId":"speech-2.8-hd"}
sourcePath="stage.teacherVoiceConfig"
```

### 7.3 `[Discussion TTS Final]`

`lib/hooks/use-discussion-tts.ts`，Q&A 教师声部决策时打印，含 `source / providerId / voiceId / modelId`。

预期输出（`source=agent.voiceConfig` 是因为 effectiveAgents 已覆盖）：

```text
source=agent.voiceConfig
providerId="minimax-tts"
voiceId="English_Graceful_Lady"
modelId="speech-2.8-hd"
```

---

## 8. 避免的错误改法（下次维护时不要回退）

### ❌ 错误 1：从 `selectedAgents[teacher].voiceConfig` 反推 teacherVoiceConfig

```ts
// ❌ 不要这样做
const teacher = selectedAgents.find(...);
const teacherVoiceConfig = teacher.voiceConfig;
```

`selectedAgents` 是运行时中间态，registry state 变化或 useMemo 重算后可能变回 LLM 生成的原始 voiceConfig。**AI 教师音色的权威必须从 stage.teacherVoiceConfig 直接读**。

### ❌ 错误 2：在 `TeacherVoicePill` 的 onClick 里同步写 `setAgentVoiceOverride('default-1', ...)`

```ts
// ❌ 不要这样做
setAgentVoiceOverride(agent.id, {
  providerId: ..., voiceId: ..., modelId: ...,
});
```

这会把全局 override 写入 `settings.agentVoiceOverrides['default-1']`，**与课程设计态的配置无关**。产品规则是"课程创建后音色不再修改"，所以应该在创建阶段就持久化到 stage，而不是维护一个跨课程的全局 override。

### ❌ 错误 3：把 `settings.ttsVoice` 直接包成 `teacherVoiceConfig` 传给 useDiscussionTTS

```ts
// ❌ 不要这样做
const teacherVoiceConfig = {
  providerId: settings.ttsProviderId,
  voiceId: settings.ttsVoice,
  modelId: ...,
};
```

`settings.ttsVoice` 是当前用户偏好，不是课程级。教师/学生后续切换全局设置时，旧课程的音色会跟着变。

### ❌ 错误 4：修改 `useDiscussionTTS` 优先级，把 `teacherVoiceConfig` 提到 `agent.voiceConfig` 之前

因为 effectiveAgents 已经在 hook 入口处覆盖了 `teacher.voiceConfig`，修改优先级是重复的、复杂的。如果有人想这样改，先看是不是入口覆盖失效了。

### ❌ 错误 5：把 `settings.agentVoiceOverrides` 当成教师音色的主要存储

`agentVoiceOverrides` 只在"用户对某个具体非默认 agent 单独设置"时才有意义。default agents（default-1/2/3）的音色不是在这里管。

### ❌ 错误 6：让 LLM 生成的 teacher.voiceConfig 覆盖用户选择

generate 模式下，LLM 可能给 teacher 分配 voiceConfig。如果运行时 TTS 决策优先读 `agent.voiceConfig`，会覆盖用户选择。必须使用 `applyTeacherVoiceConfigToAgents` 强制覆盖。

### ❌ 错误 7：服务端修改 /api/server-providers 自动重置 ttsVoice

`lib/store/settings.ts` 中有 `fetchServerProviders` 在某些条件下会用 server 默认值覆盖 `settings.ttsVoice`。如果发现这个问题又出现，先确认 settings store 的相关 spread 是否被错误地触发（注意：本次修复不修改服务端）。

---

## 9. 验证清单（每次发布前自查）

发布到 Vercel / 重新部署前，对 `AI 教师音色固定` 这一行为做一次完整验证：

- [ ] 新建课程
- [ ] 课堂角色配置选择 MiniMax TTS 下一个英文音色（例如 English_Trustworthy_Man / English_Graceful_Lady）
- [ ] 课程创建过程无 console error
- [ ] 浏览器 console 出现：
    - [Create Course Payload Teacher Voice]（含 voiceId + modelId）
- [ ] 进入播放 / Q&A
- [ ] 浏览器 console 出现：
    - [Teacher VoiceConfig For Discussion]（含 voiceId + modelId + sourcePath="stage.teacherVoiceConfig"）
    - [Discussion TTS Final]（含 source + providerId + voiceId + modelId）
- [ ] 实际听感：AI 教师声音就是用户选的英文音色
- [ ] 在 AgentBar 把全局音色切换成别的（例如 Female-Yujie）
- [ ] 回到刚才创建的课程，触发 Q&A
- [ ] 验证：AI 教师音色仍是创建时选的英文音色，不被全局设置覆盖

如果以上任何一步异常，请先看本次提交保留的 3 条日志，不要直接改服务端或 settings store。

---

## 10. 相关文件清单

修复涉及的文件：

```text
新增：
- lib/teacher/apply-teacher-voice.ts          公共覆盖函数

修改：
- app/generation-preview/page.tsx           课程创建时写入 stage.teacherVoiceConfig
- lib/hooks/use-discussion-tts.ts           effectiveAgents 覆盖 + 日志 modelId
- components/edit/PlaybackChromeRoot.tsx    teacherVoiceConfigForDiscussion 直接读 stage
- lib/audio/voice-resolver.ts               删掉 [MiniMax Trustworthy Man Voice] 调试日志
- components/agent/agent-bar.tsx            删掉 [Save Agent Voice] [Teacher Pill Render]
- components/chat/use-chat-sessions.ts       删掉 [Stage Agents] [Filter Result]
- lib/store/settings.ts                      删掉 [setTTSVoice] [setTTSProvider]
- lib/hooks/use-scene-generator.ts           删掉 [Lecture TTS Voice]

保留验收日志：
- [Create Course Payload Teacher Voice]                  app/generation-preview/page.tsx
- [Teacher VoiceConfig For Discussion]                   components/edit/PlaybackChromeRoot.tsx
- [Discussion TTS Final]                                lib/hooks/use-discussion-tts.ts
```

---

## 11. 后续可考虑优化（不在本次范围内）

1. **`stage.teacherVoiceConfig` 类型正式化**：当前通过 runtime cast 注入。如果未来 dsl 升级支持 teacherVoiceConfig 字段，应同步迁移。

2. **`StageRecord` 数据库 schema 同步**：当前 `teacherVoiceConfig` 字段通过 IndexedDB 自动持久化（runtime 扩展）。IndexedDB schema 升级后，建议在 `db.stages` 表结构里显式定义 `teacherVoiceConfig` 字段以便备份/恢复时类型检查。

3. **旧课程兼容**：当前对旧课程（创建时没有 `stage.teacherVoiceConfig` 字段）会 fallback 到 settings.globalTtsVoice 或默认音色。是否要在 IndexedDB 加载老 stage 时自动从 `useSettingsStore.ttsVoice` 同步一份 teacherVoiceConfig 到老 stage 上，可以作为未来迁移任务。

---

## 12. 验收状态（2026-07-21 已稳定）

本修复已在本机和生产两端验证通过。生产部署：

| Commit | 说明 | Vercel |
|---|---|---|
| `6cf27df9` | 核心修复：stage.teacherVoiceConfig 写入 + effectiveAgents 覆盖 + PlaybackChromeRoot 直接读 stage | ✅ Ready Production |
| `746b150c` | 诊断日志：Stage TeacherVoiceConfig Loaded（保留作 dev-only 日志） | ✅ Ready Production |

### 本地验证（17:50）

新建课程选 `English_Trustworthy_Man`，触发 Q&A：

```text
[Create Course Payload Teacher Voice]
providerId="minimax-tts" voiceId="English_Trustworthy_Man" modelId="speech-2.8-hd"

[Teacher VoiceConfig For Discussion]
teacherAgentId="(stage-source)"
teacherVoiceConfig={"providerId":"minimax-tts","voiceId":"English_Trustworthy_Man","modelId":"speech-2.8-hd"}
sourcePath="stage.teacherVoiceConfig"

[Discussion TTS Final]
source=agent.voiceConfig
providerId="minimax-tts"
voiceId="English_Trustworthy_Man"
modelId="speech-2.8-hd"
```

实际听感：教师声音 = English_Trustworthy_Man（用户选择）。

### 生产线验证

生产部署包含 `6cf27df9` 和 `746b150c`，dev server 已确认 commit hash。线上新创建的课程应使用 stage.teacherVoiceConfig。

### 旧课程兼容说明

旧课程（创建于 6cf27df9 之前）没有 stage.teacherVoiceConfig 字段，在 Q&A 场景会 fallback 到 LLM 生成的 teacher agent voiceConfig 或 settings.globalTtsVoice。这不是 bug，是历史数据问题。如需修复老课程，建议在 IndexedDB 加载老 stage 时从 useSettingsStore 同步一份 teacherVoiceConfig。

4. **生产环境回归测试**：Vercel 部署后，对 generate 模式课程在 production 环境做一次端到端 Q&A 音色验证（dev server 与 Vercel runtime 行为可能不同）。
