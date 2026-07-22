# RJ-laixue 2026-07-21 Release Notes

## 概要

本次发布解决了一个反复出现的 **AI 教师音色不一致** 问题：从课程创建到 Q&A 互动阶段，AI 教师音色被 LLM 生成角色配置覆盖，而不是遵循用户在课堂角色配置中的选择。

## 用户可见变化

- 课程创建后，AI 教师音色**严格**遵循用户在"课堂角色配置"中选择的音色
- 切换全局 TTS 设置**不再**影响已创建课程的 AI 教师音色
- Q&A / Discussion 互动时，AI 教师声音与课件播放阶段一致

## 技术变更

### 课程创建阶段

- `app/generation-preview/page.tsx`：构造 stage 时写入 `stage.teacherVoiceConfig` 字段
  - 来源：`useSettingsStore.ttsProviderId / ttsVoice / ttsProvidersConfig[provider].modelId`
  - `modelId` fallback：`settings → TTS_PROVIDERS[provider].defaultModelId → undefined`
- `stage.teacherVoiceConfig` 作为 runtime extra field 持久化到 IndexedDB 和 server-side classroom JSON

### Q&A / Discussion 阶段

- 新增 `lib/teacher/apply-teacher-voice.ts`：公共函数 `applyTeacherVoiceConfigToAgents(agents, teacherVoiceConfig)`
  - 仅修改教师身份 agent（`role==='teacher'` 或 `id==='default-1'` 或 `name==='AI教师'`）
  - 非教师 agent 完全不动
- `lib/hooks/use-discussion-tts.ts`：hook 入口处构造 `effectiveAgents = applyTeacherVoiceConfigToAgents(agents, teacherVoiceConfig)`
- `components/edit/PlaybackChromeRoot.tsx`：`teacherVoiceConfigForDiscussion` useMemo 直接读 `stage.teacherVoiceConfig`

### 优先级链（教师音色）

1. `agentVoiceOverrides[agent.id]`（settings store per-agent override）
2. `agent.voiceConfig`（course design 阶段，可被 effectiveAgents 强制覆盖）
3. `teacherVoiceConfig`（caller 传入的 stage.teacherVoiceConfig，effectiveAgents 已确保 teacher 命中）
4. `globalTtsVoice`（全局 fallback）
5. `firstVoice`（最后兜底）

## 部署

| Commit | 说明 |
|---|---|
| `6cf27df9` | 核心修复 |
| `746b150c` | 诊断日志（dev-only） |

- **生产部署**：Vercel Production Ready
- **回滚方案**：revert `6cf27df9` 后 deploy，旧课程不受影响（fallback 到 LLM 生成音色），新创建的课程会丢失教师音色持久化能力

## 验收清单

发布后请确认：

- [ ] 在 laixue.work 新建课程
- [ ] 课堂角色配置选择 MiniMax TTS / Trustworthy Man
- [ ] 课程生成完成
- [ ] 进播放 / Q&A
- [ ] 教师声音 = Trustworthy Man（用户选的音色）
- [ ] 切换全局 TTS 到别的音色，AI 教师音色**不**变化

## 不在本次范围内（已记录到 AI-TEACHER-VOICE.md）

1. 旧课程（创建于 `6cf27df9` 之前）数据迁移
2. `stage.teacherVoiceConfig` 类型正式化（DSL 类型升级）
3. `StageRecord` 数据库 schema 同步

## 故障排查

如果线上 Q&A 音色不对，**直接**贴线上浏览器 console 日志，**不再**猜测根因：

- 看到 `[Create Course Payload Teacher Voice]` 但 `[Discussion TTS Final]` 音色不对 → effectiveAgents 没生效
- 看不到 `[Create Course Payload Teacher Voice]` → stage.teacherVoiceConfig 写入失败
- 三个日志都看不到 → 客户端没运行修复代码（Vercel 没部署）