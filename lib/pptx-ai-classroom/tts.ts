import { createHash } from 'node:crypto';
import { generateTTS } from '@/lib/audio/tts-providers';
import { DEFAULT_TTS_MODELS, DEFAULT_TTS_VOICES, TTS_PROVIDERS } from '@/lib/audio/constants';
import type { SpeechAction } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { TTSProviderId } from '@/lib/audio/types';
import { getServerTTSProviders, resolveTTSApiKey, resolveTTSBaseUrl } from '@/lib/server/provider-config';
import { CosStorage } from '@/lib/server/cos-storage';
import { CourseRepository } from '@/lib/server/db/course-repository';

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
}): Promise<{ audioId: string; audioUrl: string; assetId: string }> {
  const providers = Object.entries(getServerTTSProviders())
    .filter(([id, info]) => id !== 'browser-native-tts' && !info.disabled)
    .map(([id]) => id as TTSProviderId);
  const providerId = providers[0];
  if (!providerId) throw new Error('No server TTS provider is configured');
  const provider = TTS_PROVIDERS[providerId];
  const apiKey = resolveTTSApiKey(providerId);
  if (provider?.requiresApiKey && !apiKey) throw new Error('Server TTS credentials are unavailable');
  const result = await generateTTS(
    {
      providerId,
      modelId: DEFAULT_TTS_MODELS[providerId] || '',
      voice: DEFAULT_TTS_VOICES[providerId] || 'default',
      apiKey,
      baseUrl: resolveTTSBaseUrl(providerId) || provider?.defaultBaseUrl,
    },
    input.target.text,
  );
  const audio = Buffer.from(result.audio);
  const extension = (result.format || 'mp3').replace(/^mpeg$/, 'mp3').replace(/^\./, '');
  const contentType = extension === 'mp3' ? 'audio/mpeg' : `audio/${extension}`;
  const fingerprint = createHash('sha256')
    .update(`${input.courseId}:${input.target.sceneId}:${input.target.actionId}:${input.target.text}`)
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
