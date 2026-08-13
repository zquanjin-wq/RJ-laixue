import { createHash } from 'crypto';
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

export function fingerprintSpeechVoice(
  text: string,
  voice: StageTeacherVoiceConfig,
): AudioVoiceFingerprint {
  const textHash = createHash('sha256').update(normalizeText(text)).digest('hex');
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
