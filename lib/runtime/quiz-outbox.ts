/**
 * lib/runtime/quiz-outbox.ts
 *
 * R3.2: quizAttempt shadow write → outbox mode.
 *
 * Replaces direct HTTP in shadowQuizSubmitted / shadowQuizReviewed / shadowQuizRetry
 * with outbox enqueue + background drain.
 * Uses the same R3.0 outbox infrastructure as playback.
 */

import { db } from '@/lib/utils/database';
import { scanAndDrain, cleanupExpiredLeases } from '@/lib/runtime/outbox';
import type { RuntimeOutboxEntry } from '@/lib/utils/database';
import { isRuntimeShadowEnabled } from '@/lib/runtime/shadow-writer';
import {
  readSubmittedEnvelope,
} from '@/lib/quiz/persistence';

function readResults(sceneId: string): unknown[] | null {
  try {
    const raw = localStorage.getItem(`quizResults:${sceneId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch { return null; }
}

// ─── 开关 ────────────────────────────────────────────────────────────────────

export function isQuizOutboxEnabled(): boolean {
  return isRuntimeShadowEnabled();
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * R3.2: 替代 shadowQuizSubmitted —— 入队 create → append_submit → set_status。
 */
export async function quizSubmittedViaOutbox(
  stageId: string | null | undefined,
  sceneId: string,
): Promise<'enqueued' | 'skipped' | 'disabled'> {
  if (!isQuizOutboxEnabled() || !stageId) return 'disabled';
  const envelope = readSubmittedEnvelope(sceneId);
  if (!envelope) return 'skipped';

  const sessionId = `qa:${stageId}:${sceneId}:${envelope.attemptId}`;
  const nowStr = new Date().toISOString();

  return db.transaction('rw', db.runtimeOutbox, async () => {
    let prevId: string | undefined;

    // create
    prevId = await _qEnqueue({
      kind: 'quizAttempt', op: 'create_session', sessionId,
      semanticKey: `quiz:create:${sessionId}`,
      body: { id: sessionId, kind: 'quizAttempt', stageId, status: 'active', createdAt: nowStr, updatedAt: nowStr },
    });

    // submit record
    prevId = await _qEnqueue({
      kind: 'quizAttempt', op: 'append_record', sessionId,
      semanticKey: `quiz:submit:${sessionId}`,
      body: {
        id: `${sessionId}:submit`, createdAt: nowStr, sceneId,
        payload: { phase: 'submitted' as const, answers: envelope.answers },
      },
    }, prevId);

    // set status completed
    await _qEnqueue({
      kind: 'quizAttempt', op: 'set_status', sessionId,
      semanticKey: `quiz:status:${sessionId}`,
      body: { status: 'completed' as const, updatedAt: nowStr },
    }, prevId);

    return 'enqueued' as const;
  });
}

/**
 * R3.2: 替代 shadowQuizReviewed —— 入队 append_grade。
 */
export async function quizReviewedViaOutbox(
  stageId: string | null | undefined,
  sceneId: string,
): Promise<'enqueued' | 'skipped' | 'disabled'> {
  if (!isQuizOutboxEnabled() || !stageId) return 'disabled';
  const envelope = readSubmittedEnvelope(sceneId);
  if (!envelope) return 'skipped';
  const results = readResults(sceneId);
  if (!results) return 'skipped';

  const sessionId = `qa:${stageId}:${sceneId}:${envelope.attemptId}`;
  const nowStr = new Date().toISOString();

  return db.transaction('rw', db.runtimeOutbox, async () => {
    // create (fallback — session may already exist; 409 handled as idempotent)
    const createId = await _qEnqueue({
      kind: 'quizAttempt', op: 'create_session', sessionId,
      semanticKey: `quiz:create:${sessionId}`,
      body: { id: sessionId, kind: 'quizAttempt', stageId, status: 'completed', createdAt: nowStr, updatedAt: nowStr },
    });

    await _qEnqueue({
      kind: 'quizAttempt', op: 'append_record', sessionId,
      semanticKey: `quiz:grade:${sessionId}`,
      body: {
        id: `${sessionId}:grade`, createdAt: nowStr, sceneId,
        payload: { phase: 'reviewed' as const, answers: envelope.answers, results },
      },
    }, createId);

    return 'enqueued' as const;
  });
}

/**
 * R3.2: 替代 shadowQuizRetry —— 入队 set_status:archived。
 */
export async function quizRetryViaOutbox(
  stageId: string | null | undefined,
  sceneId: string,
): Promise<'enqueued' | 'skipped' | 'disabled'> {
  if (!isQuizOutboxEnabled() || !stageId) return 'disabled';
  const envelope = readSubmittedEnvelope(sceneId);
  if (!envelope?.attemptId) return 'skipped';

  const sessionId = `qa:${stageId}:${sceneId}:${envelope.attemptId}`;
  const nowStr = new Date().toISOString();

  return db.transaction('rw', db.runtimeOutbox, async () => {
    await _qEnqueue({
      kind: 'quizAttempt', op: 'set_status', sessionId,
      semanticKey: `quiz:status:${sessionId}`,
      body: { status: 'archived' as const, updatedAt: nowStr },
    });
    return 'enqueued' as const;
  });
}

// ─── drain ───────────────────────────────────────────────────────────────────

let quizDrainRunning = false;

export async function drainQuizOutbox(tabId?: string): Promise<void> {
  if (!isQuizOutboxEnabled() || quizDrainRunning) return;
  quizDrainRunning = true;
  try {
    const tid = tabId ?? `quiz-${crypto.randomUUID().slice(0, 8)}`;
    await cleanupExpiredLeases(tid);
    await scanAndDrain(tid);
  } finally {
    quizDrainRunning = false;
  }
}

// ─── 内部辅助 ────────────────────────────────────────────────────────────────

async function _qEnqueue(
  params: { kind: 'quizAttempt'; op: RuntimeOutboxEntry['op']; sessionId: string; semanticKey: string; body: unknown },
  dependsOnEntryId?: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const nowStr = new Date().toISOString();
  const existing = await db.runtimeOutbox
    .where('semanticKey').equals(params.semanticKey)
    .filter((e) => e.status === 'pending' && !e.leaseOwner && e.id !== id)
    .toArray();
  for (const e of existing) await db.runtimeOutbox.update(e.id, { status: 'superseded' });
  const rows = await db.runtimeOutbox.where('sessionId').equals(params.sessionId).toArray();
  const lastSeq = rows.length > 0 ? Math.max(...rows.map((e) => e.sequence ?? 0)) : 0;
  const entry: RuntimeOutboxEntry = {
    id, kind: params.kind, op: params.op,
    sessionId: params.sessionId, semanticKey: params.semanticKey,
    body: params.body, createdAt: nowStr, attempts: 0, nextAttemptAt: nowStr,
    status: 'pending', sequence: lastSeq + 1, dependsOnEntryId,
  };
  await db.runtimeOutbox.put(entry);
  return id;
}
