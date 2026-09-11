import { createHash } from 'node:crypto';
import { generateTTS, TTSRateLimitError } from '@/lib/audio/tts-providers';
import { DEFAULT_TTS_MODELS, DEFAULT_TTS_VOICES, TTS_PROVIDERS } from '@/lib/audio/constants';
import type { SpeechAction } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { TTSProviderId } from '@/lib/audio/types';
import {
  getServerTTSProviders,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
} from '@/lib/server/provider-config';
import { CosStorage } from '@/lib/server/cos-storage';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { isRetryableGenerationError } from '@/lib/generation/generation-retry';

const PPTX_TTS_MAX_ATTEMPTS = 6;
const PPTX_TTS_RETRY_BASE_MS = 10_000;
const PPTX_TTS_RETRY_MAX_MS = 60_000;

export async function withPptxTtsRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (attempt: number, delayMs: number) => void | Promise<void>;
  } = {},
): Promise<T> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= PPTX_TTS_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt === PPTX_TTS_MAX_ATTEMPTS || !isRetryableGenerationError(error)) throw error;
      const exponentialDelay = Math.min(
        PPTX_TTS_RETRY_MAX_MS,
        PPTX_TTS_RETRY_BASE_MS * 2 ** (attempt - 1),
      );
      const providerDelay =
        error instanceof TTSRateLimitError ? Math.max(0, error.retryAfterSec * 1000) : 0;
      const delayMs = Math.max(exponentialDelay, providerDelay);
      await options.onRetry?.(attempt, delayMs);
      await sleep(delayMs);
    }
  }
  throw new Error('PPTX TTS retry loop exhausted');
}

export interface PptxSpeechTarget {
  sceneId: string;
  actionId: string;
  text: string;
}

export function listPptxSpeechTargets(scenes: Scene[]): PptxSpeechTarget[] {
  return scenes.flatMap((scene) =>
    (scene.actions ?? []).flatMap((action) =>
      action.type === 'speech' && action.text.trim()
        ? [{ sceneId: scene.id, actionId: action.id, text: action.text }]
        : [],
    ),
  );
}

export async function synthesizePptxSpeech(input: {
  courseId: string;
  ownerUserId: string;
  target: PptxSpeechTarget;
  courses: CourseRepository;
  /** The roster-selected teacher voice. Omit only when the roster has no binding. */
  voiceConfig?: { providerId: string; modelId?: string; voiceId: string };
}): Promise<{ audioId: string; audioUrl: string; assetId: string }> {
  const providers = Object.entries(getServerTTSProviders())
    .filter(([id, info]) => id !== 'browser-native-tts' && !info.disabled)
    .map(([id]) => id as TTSProviderId);
  const requestedProvider = input.voiceConfig?.providerId as TTSProviderId | undefined;
  // A roster binding is honored only when that provider is served by this
  // deployment. This is the server-side counterpart to upstream list_voices /
  // set_roster validation; never send an LLM-invented provider to TTS.
  const providerId =
    requestedProvider && providers.includes(requestedProvider) ? requestedProvider : providers[0];
  if (!providerId) throw new Error('No server TTS provider is configured');
  const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  const apiKey = resolveTTSApiKey(providerId);
  if (provider?.requiresApiKey && !apiKey)
    throw new Error('Server TTS credentials are unavailable');
  const requestedVoice =
    input.voiceConfig?.providerId === providerId ? input.voiceConfig.voiceId : undefined;
  const voice =
    requestedVoice && provider?.voices.some((item) => item.id === requestedVoice)
      ? requestedVoice
      : DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES] || 'default';
  const result = await generateTTS(
    {
      providerId,
      modelId:
        input.voiceConfig?.providerId === providerId
          ? input.voiceConfig.modelId ||
            DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] ||
            ''
          : DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] || '',
      voice,
      apiKey,
      baseUrl: resolveTTSBaseUrl(providerId) || provider?.defaultBaseUrl,
    },
    input.target.text,
  );
  const audio = Buffer.from(result.audio);
  const extension = (result.format || 'mp3').replace(/^mpeg$/, 'mp3').replace(/^\./, '');
  const contentType = extension === 'mp3' ? 'audio/mpeg' : `audio/${extension}`;
  const fingerprint = createHash('sha256')
    .update(
      `${input.courseId}:${input.target.sceneId}:${input.target.actionId}:${input.target.text}`,
    )
    .digest('hex');
  const objectKey = `courses/${input.courseId}/audio/pptx/${fingerprint}.${extension}`;
  await new CosStorage().putObject(objectKey, audio, contentType);
  const asset = await input.courses.createAsset({
    ownerUserId: input.ownerUserId,
    courseId: input.courseId,
    kind: 'audio',
    objectKey,
    contentType,
    sizeBytes: audio.length,
  });
  const ready = await input.courses.markAssetReady(objectKey, input.ownerUserId);
  if (!ready) throw new Error('Generated PPTX narration asset could not be confirmed');
  return {
    audioId: `pptx_${fingerprint.slice(0, 20)}`,
    audioUrl: `/api/course-assets/object?key=${encodeURIComponent(objectKey)}`,
    assetId: asset.id,
  };
}

export async function synthesizePptxSpeechWithRetry(
  input: Parameters<typeof synthesizePptxSpeech>[0],
  options?: Parameters<typeof withPptxTtsRetry>[1],
) {
  return withPptxTtsRetry(() => synthesizePptxSpeech(input), options);
}

export function applyPptxSpeechAudio(
  scenes: Scene[],
  audio: Map<string, { audioId: string; audioUrl: string }>,
): Scene[] {
  return scenes.map((scene) => ({
    ...scene,
    actions: (scene.actions ?? []).map((action) => {
      if (action.type !== 'speech') return action;
      const item = audio.get(`${scene.id}:${action.id}`);
      return item ? ({ ...action, ...item } satisfies SpeechAction) : action;
    }),
  }));
}
