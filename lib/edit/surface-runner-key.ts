import type { SceneType } from '@/lib/types/stage';

/**
 * React hook implementations may differ between the read-only fallback and a
 * lazily registered editor surface. They must never reuse one runner instance.
 */
export function surfaceRunnerKey(
  sceneType: SceneType,
  resolvedSurfaceType: SceneType | null,
): string {
  return resolvedSurfaceType ? `registered:${resolvedSurfaceType}` : `noop:${sceneType}`;
}
