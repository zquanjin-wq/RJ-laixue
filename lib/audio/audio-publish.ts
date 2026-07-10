import type { Action, SpeechAction } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import { db, type AudioFileRecord } from '@/lib/utils/database';

export interface PublishedAudioItem {
  sceneId: string;
  sceneOrder?: number;
  actionId?: string;
  audioId: string;
  audioUrl?: string;
}

export interface MissingAudioItem {
  sceneId: string;
  sceneOrder?: number;
  actionId?: string;
  audioId: string;
  reason: string;
}

export interface FailedAudioItem {
  sceneId: string;
  sceneOrder?: number;
  actionId?: string;
  audioId: string;
  error: string;
}

export interface PublishSceneAudioAssetsResult {
  scenes: Scene[];
  uploaded: PublishedAudioItem[];
  skipped: PublishedAudioItem[];
  missing: MissingAudioItem[];
  failed: FailedAudioItem[];
}

function isSpeechAction(action: Action): action is SpeechAction {
  return action.type === 'speech';
}

function normalizeAudioFormat(format?: string): string {
  const normalized = (format || 'mp3').trim().toLowerCase();
  if (!normalized) return 'mp3';
  if (normalized === 'mpeg') return 'mp3';
  return normalized.replace(/^\./, '');
}

function contentTypeForAudio(format?: string): string {
  const normalized = normalizeAudioFormat(format);
  if (normalized === 'mp3') return 'audio/mpeg';
  if (normalized === 'wav') return 'audio/wav';
  if (normalized === 'ogg') return 'audio/ogg';
  if (normalized === 'webm') return 'audio/webm';
  if (normalized === 'm4a') return 'audio/mp4';
  return `audio/${normalized}`;
}

function safeFileName(audioId: string, format?: string): string {
  const ext = normalizeAudioFormat(format);
  const safeAudioId = audioId
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .toLowerCase();

  return `${safeAudioId || 'audio'}.${ext}`;
}

async function uploadAudioRecordToCloud(input: {
  stageId: string;
  audioId: string;
  record: AudioFileRecord;
}): Promise<string> {
  const { stageId, audioId, record } = input;

  const format = normalizeAudioFormat(record.format);
  const fileName = safeFileName(audioId, format);
  const contentType = record.blob.type || contentTypeForAudio(format);

  const file = new File([record.blob], fileName, {
    type: contentType,
  });

  const formData = new FormData();
  formData.append('file', file);
  formData.append('stageId', stageId);
  formData.append('audioId', audioId);

  const response = await fetch('/api/audio-upload', {
    method: 'POST',
    body: formData,
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.url) {
    const message =
      data?.details ||
      data?.error ||
      `Audio upload failed: HTTP ${response.status}`;
    throw new Error(message);
  }

  return data.url as string;
}

/**
 * Ensure speech actions have cloud-playable audioUrl before course publishing.
 *
 * audioId = browser-local IndexedDB cache key.
 * audioUrl = cloud URL required by shared/student playback.
 */
export async function publishSceneAudioAssets(
  stageId: string,
  scenes: Scene[],
): Promise<PublishSceneAudioAssetsResult> {
  const nextScenes = structuredClone(scenes) as Scene[];

  const uploaded: PublishedAudioItem[] = [];
  const skipped: PublishedAudioItem[] = [];
  const missing: MissingAudioItem[] = [];
  const failed: FailedAudioItem[] = [];

  for (const scene of nextScenes) {
    const actions = scene.actions ?? [];

    for (const action of actions) {
      if (!isSpeechAction(action)) continue;

      const speechAction = action as SpeechAction & {
        audioId?: string;
        audioUrl?: string;
      };

      const sceneId = scene.id;
      const sceneOrder = scene.order;
      const actionId = speechAction.id;
      const audioId = speechAction.audioId;

      if (speechAction.audioUrl) {
        skipped.push({
          sceneId,
          sceneOrder,
          actionId,
          audioId: audioId || '',
          audioUrl: speechAction.audioUrl,
        });
        continue;
      }

      if (!audioId) {
        continue;
      }

      const record = await db.audioFiles.get(audioId);

      if (!record?.blob) {
        missing.push({
          sceneId,
          sceneOrder,
          actionId,
          audioId,
          reason: '本地 IndexedDB 中找不到对应音频文件',
        });
        continue;
      }

      try {
        const audioUrl = await uploadAudioRecordToCloud({
          stageId,
          audioId,
          record,
        });

        speechAction.audioUrl = audioUrl;

        uploaded.push({
          sceneId,
          sceneOrder,
          actionId,
          audioId,
          audioUrl,
        });
      } catch (error) {
        failed.push({
          sceneId,
          sceneOrder,
          actionId,
          audioId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    scenes: nextScenes,
    uploaded,
    skipped,
    missing,
    failed,
  };
}
