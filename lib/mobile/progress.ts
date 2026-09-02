/**
 * lib/mobile/progress.ts
 *
 * Per-course learning progress stored in localStorage. Stores the
 * current scene index + playback offset so users can resume a
 * partially-completed course on next visit.
 *
 * Key shape: `mobile.progress.<courseId>` → JSON
 *
 * No server roundtrip — this is purely a client-side affordance.
 * Phase 2 will mirror these to server-side `course_progress_events`.
 */

const STORAGE_PREFIX = 'mobile.progress.';

export interface CourseProgress {
  /** Course ID this progress belongs to. */
  courseId: string;
  /** Index into the scenes array (0-based). */
  sceneIndex: number;
  /** Seconds offset within the current scene's audio. */
  audioOffset: number;
  /** Total scenes in this course at last save time. */
  totalScenes: number;
  /** ISO timestamp of the last update. */
  updatedAt: string;
}

export function getProgress(courseId: string): CourseProgress | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + courseId);
    if (!raw) return null;
    return JSON.parse(raw) as CourseProgress;
  } catch {
    return null;
  }
}

export function setProgress(progress: CourseProgress): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      STORAGE_PREFIX + progress.courseId,
      JSON.stringify(progress),
    );
  } catch {
    // localStorage quota exceeded or disabled — silently ignore
  }
}

export function clearProgress(courseId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_PREFIX + courseId);
  } catch {
    // ignore
  }
}

/**
 * Mark the current scene as complete and advance to the next.
 * Returns the new progress, or the same one if already at the last
 * scene.
 */
export function markSceneComplete(courseId: string, totalScenes: number): CourseProgress {
  const prev = getProgress(courseId);
  const nextIndex = Math.min((prev?.sceneIndex ?? -1) + 1, totalScenes - 1);
  const next: CourseProgress = {
    courseId,
    sceneIndex: nextIndex,
    audioOffset: 0,
    totalScenes,
    updatedAt: new Date().toISOString(),
  };
  setProgress(next);
  return next;
}