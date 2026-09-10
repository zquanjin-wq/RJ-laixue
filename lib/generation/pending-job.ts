/**
 * Browser-resumable handle for a durable course-generation task.
 *
 * The worker owns execution, but the creation page owns the progress view.
 * Keeping this small, non-sensitive handle in session storage lets a reload
 * reconnect to the same task instead of submitting a second course.
 */
export const PENDING_GENERATION_JOB_STORAGE_KEY = 'laixue-pending-generation-job';

export interface PendingGenerationJob {
  jobId: string;
  courseId: string;
  pollUrl: string;
  kind: 'pptx' | 'text';
  createdAt: number;
}

export function parsePendingGenerationJob(value: unknown): PendingGenerationJob | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.jobId !== 'string' ||
    typeof candidate.courseId !== 'string' ||
    typeof candidate.pollUrl !== 'string' ||
    (candidate.kind !== 'pptx' && candidate.kind !== 'text') ||
    typeof candidate.createdAt !== 'number' ||
    !Number.isFinite(candidate.createdAt)
  ) {
    return null;
  }
  return {
    jobId: candidate.jobId,
    courseId: candidate.courseId,
    pollUrl: candidate.pollUrl,
    kind: candidate.kind,
    createdAt: candidate.createdAt,
  };
}

export function readPendingGenerationJob(): PendingGenerationJob | null {
  if (typeof window === 'undefined') return null;
  try {
    return parsePendingGenerationJob(JSON.parse(window.sessionStorage.getItem(PENDING_GENERATION_JOB_STORAGE_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

export function savePendingGenerationJob(job: PendingGenerationJob): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(PENDING_GENERATION_JOB_STORAGE_KEY, JSON.stringify(job));
  } catch {
    // Storage may be blocked; the server task remains durable regardless.
  }
}

export function clearPendingGenerationJob(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(PENDING_GENERATION_JOB_STORAGE_KEY);
  } catch {
    // Storage may be blocked or unavailable.
  }
}
