import type { Scene, Stage } from '@/lib/types/stage';
import type { StageTeacherVoiceConfig } from './apply-teacher-voice';
import { db } from '@/lib/utils/database';
import { publishSceneAudioAssets, validatePublishedAudioAssets } from '@/lib/audio/audio-publish';
import { externalizeCourseAssets } from '@/lib/course-assets/externalize';
import { stripRuntimeOnly } from '@/lib/dsl-extensions/serialize';

interface ReplaceTeacherVoiceInput {
  stage: Stage;
  scenes: Scene[];
  outlines: unknown[];
  voice: StageTeacherVoiceConfig;
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
}: ReplaceTeacherVoiceInput) {
  const stageId = stage.id;
  // The signed-upload API requires a course row to exist. Persist the current
  // snapshot as a recoverable draft first; it intentionally keeps the old
  // voice/audio until the complete revoice snapshot is ready.
  const prepareResponse = await fetch('/api/courses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: stageId,
      title: stage.name?.trim?.() || '未命名课程',
      topic: stage.name?.trim?.() || '',
      saveState: 'draft',
      data: { stage, scenes, outlines },
    }),
  });
  const prepareJson = await prepareResponse.json().catch(() => null);
  if (!prepareResponse.ok || !prepareJson?.success) {
    throw new Error(prepareJson?.error || '无法准备云端课程，尚未开始重新配音');
  }

  const publish = await publishSceneAudioAssets(stageId, scenes, voice, {
    forceRegenerate: true,
  });
  const validation = validatePublishedAudioAssets(publish.scenes);
  if (!validation.ok || publish.failed.length || publish.missing.length) {
    const count = publish.failed.length + publish.missing.length + validation.issues.length;
    throw new Error(`重新配音未完成（${count} 处失败），课程仍保留原音色`);
  }

  const nextStage = { ...stage, teacherVoiceConfig: voice } as Stage & {
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
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.success) {
    throw new Error(json?.error || '新配音保存至云端失败，课程仍保留原音色');
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
