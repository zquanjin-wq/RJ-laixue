import type { Scene, Stage } from '@/lib/types/stage';
import type { StageTeacherVoiceConfig } from './apply-teacher-voice';
import { db } from '@/lib/utils/database';
import { publishSceneAudioAssets, validatePublishedAudioAssets } from '@/lib/audio/audio-publish';
import { externalizeCourseAssets } from '@/lib/course-assets/externalize';
import { prepareCourseForAssetUploads } from '@/lib/course-assets/prepare-course';
import { stripRuntimeOnly } from '@/lib/dsl-extensions/serialize';

interface ReplaceTeacherVoiceInput {
  stage: Stage;
  scenes: Scene[];
  outlines: unknown[];
  voice: StageTeacherVoiceConfig;
  signal?: AbortSignal;
  onProgress?: (progress: { completed: number; total: number; sceneId: string }) => void;
}

/**
 * Revoices a course without exposing a partially-updated course snapshot.
 * Audio blobs may be uploaded before commit (safe orphans); stage/scenes are
 * changed locally and in the courses row only after every required action has
 * a cloud URL.
 */
export async function replaceTeacherVoice({
  stage,
  scenes,
  outlines,
  voice,
  signal,
  onProgress,
}: ReplaceTeacherVoiceInput) {
  const stageId = stage.id;
  // Externalize inline media before writing the recovery draft. New courses
  // use a pending namespace, so the deployment gateway never receives a
  // Base64-heavy JSON body before the persistent row exists.
  const prepared = await prepareCourseForAssetUploads({
    id: stageId,
    title: stage.name?.trim?.() || '\u672a\u547d\u540d\u8bfe\u7a0b',
    topic: stage.name?.trim?.() || '',
    stage: stage as unknown as Record<string, unknown>,
    scenes: scenes as unknown as Record<string, unknown>[],
    outlines,
  });
  const preparedStage = prepared.stage as unknown as Stage;
  const preparedScenes = prepared.scenes as unknown as Scene[];

  const publish = await publishSceneAudioAssets(stageId, preparedScenes, voice, {
    forceRegenerate: true,
    signal,
    onProgress,
  });
  const validation = validatePublishedAudioAssets(publish.scenes);
  if (!validation.ok || publish.failed.length || publish.missing.length) {
    const count = publish.failed.length + publish.missing.length + validation.issues.length;
    throw new Error(`重新配音未完成（${count} 处失败），课程仍保留原音色`);
  }

  const nextStage = { ...preparedStage, teacherVoiceConfig: voice } as Stage & {
    teacherVoiceConfig: StageTeacherVoiceConfig;
  };
  const externalized = await externalizeCourseAssets(
    stageId,
    nextStage as unknown as Record<string, unknown>,
    publish.scenes as unknown as Record<string, unknown>[],
  );
  const stageToSave = stripRuntimeOnly(externalized.stage);
  const scenesToSave = externalized.scenes;
  const response = await fetch('/api/courses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: stageId,
      title: stage.name?.trim?.() || '未命名课程',
      topic: stage.name?.trim?.() || '',
      saveState: 'ready',
      data: { stage: stageToSave, scenes: scenesToSave, outlines },
    }),
  });
  const responseText = await response.text();
  let json: { success?: boolean; error?: string } | null = null;
  try {
    json = JSON.parse(responseText) as { success?: boolean; error?: string };
  } catch {
    // The deployment gateway can return a plain-text error before Next.js.
  }
  if (!response.ok || !json?.success) {
    const detail = json?.error || responseText.slice(0, 200) || 'cloud save failed';
    throw new Error(response.status === 413 ? 'Revoiced course is still too large to save.' : detail);
  }

  const now = Date.now();
  const persistedScenes = scenesToSave.map((scene, index) => ({
    ...scene,
    seq: (scene as { seq?: number }).seq ?? index,
    createdAt: (scene as { createdAt?: number }).createdAt ?? now,
    updatedAt: now,
  })) as unknown as Scene[];
  let localPersistenceSucceeded = true;
  try {
    await db.transaction('rw', db.stages, db.scenes, async () => {
      await db.stages.put(stageToSave as unknown as typeof stage);
      await db.scenes.bulkPut(persistedScenes as Parameters<typeof db.scenes.bulkPut>[0]);
    });
  } catch {
    // Cloud commit already succeeded. Return the committed snapshot so the UI
    // immediately reflects the server source of truth; the regular storage
    // debounce gets another chance to repair IndexedDB.
    localPersistenceSucceeded = false;
  }

  return {
    stage: stageToSave as unknown as Stage,
    scenes: persistedScenes,
    localPersistenceSucceeded,
  };
}
