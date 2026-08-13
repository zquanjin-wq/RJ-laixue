import type { StageTeacherVoiceConfig } from '@/lib/teacher/apply-teacher-voice';

export interface AudioVoiceFingerprint {
  providerId: string;
  voiceId: string;
  modelId?: string;
  textHash: string;
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Deliberately small, deterministic hash that works in both the browser and
 * server runtimes. This is an identity marker, not a security boundary.
 */
function textFingerprint(text: string): string {
  const normalized = normalizeText(text);
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}-${normalized.length}`;
}

export function fingerprintSpeechVoice(
  text: string,
  voice: StageTeacherVoiceConfig,
): AudioVoiceFingerprint {
  const textHash = textFingerprint(text);
  return {
    providerId: voice.providerId,
    voiceId: voice.voiceId,
    ...(voice.modelId ? { modelId: voice.modelId } : {}),
    textHash,
  };
}

export function speechVoiceMatches(
  current: unknown,
  text: string,
  target: StageTeacherVoiceConfig,
): boolean {
  if (!current || typeof current !== 'object') return false;
  const expected = fingerprintSpeechVoice(text, target);
  const actual = current as Partial<AudioVoiceFingerprint>;
  return (
    actual.providerId === expected.providerId &&
    actual.voiceId === expected.voiceId &&
    actual.modelId === expected.modelId &&
    actual.textHash === expected.textHash
  );
}
