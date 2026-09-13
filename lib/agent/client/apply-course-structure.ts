import { useStageStore } from '@/lib/store/stage';
import type { EditCourseStructureDetails } from '@/lib/agent/tools/edit-course-structure';
import { createBlankSlideScene, duplicateSlideScene } from '@/lib/edit/slide-defaults';

export function applyCourseStructureEdits(details: EditCourseStructureDetails): {
  ok: boolean;
  reason?: string;
} {
  if (!details.operations?.length) return { ok: false, reason: details.refuseReason || 'No edits.' };
  const store = useStageStore.getState();
  if (!store.stage) return { ok: false, reason: 'Course is not loaded.' };
  let scenes = store.scenes;
  let nextCurrentSceneId = store.currentSceneId;
  let structureChanged = false;
  for (const operation of details.operations) {
    if (operation.type === 'rename') {
      if (!scenes.some((scene) => scene.id === operation.sceneId)) return { ok: false, reason: 'Page no longer exists.' };
      const title = operation.title.trim();
      if (!title) return { ok: false, reason: 'Page title is empty.' };
      scenes = scenes.map((scene) =>
        scene.id === operation.sceneId
          ? { ...scene, title, updatedAt: Math.max(Date.now(), (scene.updatedAt ?? 0) + 1) }
          : scene,
      );
      continue;
    }
    if (operation.type === 'reorder') {
      const byId = new Map(scenes.map((scene) => [scene.id, scene] as const));
      if (operation.sceneIds.length !== scenes.length || operation.sceneIds.some((id) => !byId.has(id))) {
        return { ok: false, reason: 'Course changed while the edit was running.' };
      }
      scenes = operation.sceneIds.map((id, index) => {
        const scene = byId.get(id)!;
        return scene.order === index + 1
          ? scene
          : { ...scene, order: index + 1, updatedAt: Math.max(Date.now(), (scene.updatedAt ?? 0) + 1) };
      });
      structureChanged = true;
      continue;
    }
    if (operation.type === 'add_blank') {
      const anchorIndex = operation.afterSceneId
        ? scenes.findIndex((scene) => scene.id === operation.afterSceneId)
        : scenes.length - 1;
      if (operation.afterSceneId && anchorIndex < 0) return { ok: false, reason: 'Page no longer exists.' };
      const blank = createBlankSlideScene(store.stage.id, operation.title?.trim() || '未命名页面', anchorIndex + 2);
      scenes = [...scenes.slice(0, anchorIndex + 1), blank, ...scenes.slice(anchorIndex + 1)];
      nextCurrentSceneId = blank.id;
      structureChanged = true;
      continue;
    }
    if (operation.type === 'duplicate') {
      const sourceIndex = scenes.findIndex((scene) => scene.id === operation.sceneId);
      const source = scenes[sourceIndex];
      if (!source) return { ok: false, reason: 'Page no longer exists.' };
      if (source.type !== 'slide') return { ok: false, reason: 'Only slide pages can be duplicated.' };
      const copy = duplicateSlideScene(source, '副本', sourceIndex + 2);
      if (operation.title?.trim()) copy.title = operation.title.trim();
      scenes = [...scenes.slice(0, sourceIndex + 1), copy, ...scenes.slice(sourceIndex + 1)];
      nextCurrentSceneId = copy.id;
      structureChanged = true;
      continue;
    }
    if (scenes.length <= 1) return { ok: false, reason: 'A course must keep at least one page.' };
    const deleteIndex = scenes.findIndex((scene) => scene.id === operation.sceneId);
    if (deleteIndex < 0) return { ok: false, reason: 'Page no longer exists.' };
    scenes = scenes.filter((scene) => scene.id !== operation.sceneId);
    if (nextCurrentSceneId === operation.sceneId) {
      nextCurrentSceneId = scenes[Math.min(deleteIndex, scenes.length - 1)]?.id ?? null;
    }
    structureChanged = true;
  }
  if (structureChanged) {
    const changedAt = Date.now();
    scenes = scenes.map((scene, index) =>
      scene.order === index + 1
        ? scene
        : { ...scene, order: index + 1, updatedAt: Math.max(changedAt, (scene.updatedAt ?? 0) + 1) },
    );
  }
  store.setScenes(scenes);
  if (nextCurrentSceneId !== store.currentSceneId) store.setCurrentSceneId(nextCurrentSceneId);
  return { ok: true };
}
