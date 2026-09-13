import { useStageStore } from '@/lib/store/stage';
import type { EditCourseStructureDetails } from '@/lib/agent/tools/edit-course-structure';

export function applyCourseStructureEdits(details: EditCourseStructureDetails): {
  ok: boolean;
  reason?: string;
} {
  if (!details.operations?.length) return { ok: false, reason: details.refuseReason || 'No edits.' };
  const store = useStageStore.getState();
  let scenes = store.scenes;
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
    const byId = new Map(scenes.map((scene) => [scene.id, scene] as const));
    if (operation.sceneIds.length !== scenes.length || operation.sceneIds.some((id) => !byId.has(id))) {
      return { ok: false, reason: 'Course changed while the edit was running.' };
    }
    scenes = operation.sceneIds.map((id, index) => ({ ...byId.get(id)!, order: index + 1 }));
  }
  store.setScenes(scenes);
  return { ok: true };
}
