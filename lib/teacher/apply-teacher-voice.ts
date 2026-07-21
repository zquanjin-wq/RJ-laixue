/**
 * Apply the course-design-time teacher voice selection to a list of agents.
 *
 * Background: the teacher agent in `useAgentRegistry` may come from one of:
 *   • DEFAULT_AGENTS (preset mode): `voiceConfig` is always undefined.
 *   • LLM-generated (`agentMode === 'generate'`): `voiceConfig` may carry
 *     a different voice than what the user actually selected at course
 *     creation time.
 *
 * Either way, the authoritative teacher voice is the one captured at
 * course creation via `stage.teacherVoiceConfig`. This helper projects that
 * selection onto the in-memory agent list so downstream TTS resolvers see
 * the right voice without polluting the registry.
 *
 * Behaviour:
 *   • Only teacher-shaped agents are touched (`role === 'teacher'` or
 *     `id === 'default-1'` or `name === 'AI教师'`).
 *   • The override always wins — even if the agent already has a
 *     `voiceConfig` (e.g. LLM-generated). Non-teacher agents are returned
 *     untouched.
 *   • When `teacherVoiceConfig` is absent, the input is returned as-is.
 */

import type { AgentConfig } from '@/lib/orchestration/registry/types';

export interface StageTeacherVoiceConfig {
  providerId: string;
  voiceId: string;
  modelId?: string;
}

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
    const finalVoiceConfig = {
      providerId: teacherVoiceConfig.providerId as AgentConfig['voiceConfig'] extends {
        providerId: infer P;
      }
        ? P
        : never,
      voiceId: teacherVoiceConfig.voiceId,
      ...(teacherVoiceConfig.modelId
        ? { modelId: teacherVoiceConfig.modelId }
        : {}),
    };
    return { ...a, voiceConfig: finalVoiceConfig };
  });
}
