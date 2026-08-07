/**
 * Bounded concurrency TTS request queue.
 *
 * Replaces the unbounded parallel fetch loops in audio-publish.ts and
 * use-scene-generator.ts. Default 3 concurrent, 429 retry with backoff,
 * single-item failure does NOT block the whole queue.
 *
 * Usage:
 *   const results = await ttsQueue(enqueueTasks(sceneActions), {
 *     onStatus: (id, status) => { ... },
 *   });
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('TTSQueue');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TTSQueueTask {
  /** Unique per-item key (typically audioId). Used for idempotent retry. */
  id: string;
  /** The fetch call that issues POST /api/generate/tts and returns the Response. */
  execute: () => Promise<Response>;
}

export interface TTSQueueResult {
  id: string;
  status: 'ok' | 'failed';
  response?: Response;
  error?: string;
}

export interface TTSQueueOptions {
  /** Max concurrent in-flight requests (default 3). */
  concurrency?: number;
  /** Max total retries per task (including the first attempt, default 5). */
  maxAttempts?: number;
  /** Called after each task finishes (success or failure). */
  onTaskDone?: (result: TTSQueueResult, progress: { done: number; total: number }) => void;
}

// ── Implementation ────────────────────────────────────────────────────────────

const JITTER_MS = 500; // max random jitter added to backoff

function backoffDelay(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec && retryAfterSec > 0) {
    // Server-suggested delay: respect it + jitter
    return retryAfterSec * 1000 + Math.random() * JITTER_MS;
  }
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s + jitter
  const base = Math.pow(2, attempt - 1) * 1000;
  return base + Math.random() * JITTER_MS;
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function extractRetryAfterSec(response: Response): Promise<number | undefined> {
  // Guard against mock Response objects lacking .headers (test compat)
  const header = response.headers?.get?.('Retry-After');
  if (header) {
    const n = parseInt(header, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  // Fallback: parse body (clone may also be missing in mocks)
  try {
    if (typeof response.clone === 'function') {
      const body = await response.clone().json();
      if (typeof body.retryAfterSec === 'number' && body.retryAfterSec > 0) {
        return body.retryAfterSec;
      }
    }
  } catch {
    // body may not be JSON
  }
  return undefined;
}

/**
 * Execute all tasks with bounded concurrency and automatic 429/5xx retry.
 *
 * Tasks are processed in FIFO order. At most `concurrency` tasks are in
 * flight at any time. When a task hits a retryable error (429/5xx) it
 * backs off and retries up to maxAttempts times (default 5). Non-retryable
 * errors (4xx except 429) fail immediately.
 *
 * A single task failure never aborts the entire queue.
 */
export async function ttsQueue(
  tasks: TTSQueueTask[],
  options: TTSQueueOptions = {},
): Promise<TTSQueueResult[]> {
  const concurrency = options.concurrency ?? 3;
  const maxAttempts = options.maxAttempts ?? 5;
  const total = tasks.length;

  const results: TTSQueueResult[] = new Array(total);
  let cursor = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= total) return;

      const task = tasks[idx];
      let lastError = '';

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const response = await task.execute();

          if (response.ok) {
            results[idx] = { id: task.id, status: 'ok', response };
            completed++;
            options.onTaskDone?.(results[idx], { done: completed, total });
            break;
          }

          if (isRetryable(response.status)) {
            const retryAfterSec = await extractRetryAfterSec(response);
            lastError = `HTTP ${response.status}${retryAfterSec ? ` (retryAfter=${retryAfterSec}s)` : ''}`;
            if (attempt < maxAttempts) {
              const delay = backoffDelay(attempt, retryAfterSec);
              log.warn(
                `TTS queue retry: ${task.id} (attempt ${attempt}/${maxAttempts}, ` +
                  `${lastError}, waiting ${(delay / 1000).toFixed(1)}s)`,
              );
              await new Promise((r) => setTimeout(r, delay));
              continue;
            }
          } else {
            lastError = `HTTP ${response.status} (non-retryable)`;
          }
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          if (attempt < maxAttempts && isRetryableNetworkError(e)) {
            const delay = backoffDelay(attempt);
            log.warn(
              `TTS queue retry: ${task.id} (attempt ${attempt}/${maxAttempts}, network error, waiting ${(delay / 1000).toFixed(1)}s)`,
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
        }

        // All retries exhausted → fail this task
        results[idx] = { id: task.id, status: 'failed', error: lastError };
        completed++;
        options.onTaskDone?.(results[idx], { done: completed, total });
        break;
      }
    }
  }

  const workerCount = Math.min(concurrency, total);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

function isRetryableNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout')
  );
}

/**
 * Convenience wrapper: enqueue a single TTS fetch call with queue-based
 * concurrency + retry. Drop-in around a fetch('/api/generate/tts', ...)
 * call for callers that already iterate over individual tasks (audio-publish,
 * use-scene-generator).
 *
 * Returns { success, response? }. Callers should check `success` and read
 * `response.json()` as before.
 */
export async function enqueueTTSFetchTask(
  id: string,
  execute: () => Promise<Response>,
): Promise<{ success: boolean; response?: Response; error?: string }> {
  const results = await ttsQueue([{ id, execute }], { concurrency: 3, maxAttempts: 5 });
  const r = results[0];
  return r.status === 'ok'
    ? { success: true, response: r.response }
    : { success: false, error: r.error };
}
