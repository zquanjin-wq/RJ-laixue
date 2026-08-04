/**
 * lib/runtime/quiz-outbox.ts
 *
 * R3.2: quizAttempt shadow write → outbox mode.
 * Strict sequential chain: create → submit → completed → reviewed → archived
 * Chain tail persisted in succeededEntries (same rw tx as outbox enqueue).
 */

import { db } from '@/lib/utils/database';
import { scanAndDrain, cleanupExpiredLeases } from '@/lib/runtime/outbox';
import type { RuntimeOutboxEntry } from '@/lib/utils/database';
import { isRuntimeShadowEnabled } from '@/lib/runtime/shadow-writer';
import { readSubmittedEnvelope } from '@/lib/quiz/persistence';

function readResults(sceneId: string): unknown[] | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(`quizResults:${sceneId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch { return null; }
}

// ─── 开关 / ready ────────────────────────────────────────────────────────────

export function isQuizOutboxEnabled(): boolean {
  return isRuntimeShadowEnabled() && process.env.NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ === '1';
}

const QUIZ_READY_KEY = 'r3:quiz:outbox:ready';

export function isQuizOutboxReady(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return isQuizOutboxEnabled() && localStorage.getItem(QUIZ_READY_KEY) === '1';
}

export function setQuizOutboxReady(): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(QUIZ_READY_KEY, '1');
}

// ─── 链尾（Dexie succeededEntries，与 outbox 同事务）────────────────────────

function _chainKey(sessionId: string): string {
  return `r3quiz:tail:${sessionId}`;
}

/** 在事务内读取链尾 entry ID（可为 undefined） */
async function _getTailInTx(sessionId: string): Promise<string | undefined> {
  const row = await db.succeededEntries.get(_chainKey(sessionId));
  return row ? row.deletedAt : undefined; // repurposing deletedAt as tail entry id
}

/** 在事务内更新链尾 */
async function _setTailInTx(sessionId: string, entryId: string): Promise<void> {
  await db.succeededEntries.put({ entryId: _chainKey(sessionId), deletedAt: entryId });
}

// ─── drain / scheduler ───────────────────────────────────────────────────────

let quizDrainRunning = false;
let quizDrainTimer: ReturnType<typeof setTimeout> | null = null;

async function resolveQuizEffectiveTime(entry: RuntimeOutboxEntry): Promise<number> {
  const allEntries = await db.runtimeOutbox.where('kind').equals('quizAttempt').toArray();
  const byId = new Map(allEntries.map((e) => [e.id, e]));
  const succIds = new Set((await db.succeededEntries.toArray()).map((s) => s.entryId));
  let current = entry;
  let blockerTime = new Date(entry.nextAttemptAt).getTime();
  const visited = new Set<string>();
  for (let depth = 0; depth < 50; depth++) {
    if (!current.dependsOnEntryId || visited.has(current.id)) break;
    visited.add(current.id);
    const depId = current.dependsOnEntryId;
    if (succIds.has(depId)) break;
    const dep = byId.get(depId);
    if (!dep) break;
    if (dep.status === 'dead' || dep.status === 'superseded') break;
    if (dep.status === 'sending' && dep.leaseUntil) {
      blockerTime = Math.max(blockerTime, new Date(dep.leaseUntil).getTime());
      break;
    }
    if (dep.status === 'pending') {
      blockerTime = Math.max(blockerTime, new Date(dep.nextAttemptAt).getTime());
      current = dep; continue;
    }
    break;
  }
  return Math.max(new Date(entry.nextAttemptAt).getTime(), blockerTime);
}

async function scheduleNextQuizDrain(): Promise<void> {
  if (quizDrainTimer) { clearTimeout(quizDrainTimer); quizDrainTimer = null; }
  if (!isQuizOutboxEnabled()) return;
  const pending = await db.runtimeOutbox.where('kind').equals('quizAttempt')
    .filter((e) => e.status === 'pending').toArray();
  if (pending.length === 0) return;
  const times = await Promise.all(pending.map((e) => resolveQuizEffectiveTime(e)));
  const delay = Math.max(1000, Math.min(...times) - Date.now()) + 50;
  quizDrainTimer = setTimeout(() => void drainQuizOutbox(), delay);
}

export async function drainQuizOutbox(tabId?: string): Promise<void> {
  if (!isQuizOutboxEnabled() || quizDrainRunning) return;
  quizDrainRunning = true;
  try {
    const tid = tabId ?? `quiz-${crypto.randomUUID().slice(0, 8)}`;
    await cleanupExpiredLeases(tid);
    await scanAndDrain(tid);
  } finally {
    quizDrainRunning = false;
    await scheduleNextQuizDrain();
  }
}

export function scheduleQuizOutboxDrain(): void {
  if (!isQuizOutboxEnabled()) return;
  setTimeout(() => void drainQuizOutbox(), 100);
}

export async function onQuizOutboxStartup(tabId?: string): Promise<{ ready: boolean }> {
  if (!isQuizOutboxEnabled()) return { ready: false };
  const tid = tabId ?? `quiz-startup-${crypto.randomUUID().slice(0, 8)}`;
  await cleanupExpiredLeases(tid);
  await drainQuizOutbox(tid);
  setQuizOutboxReady();
  return { ready: true };
}

// ─── 公开 API — 严格链 ──────────────────────────────────────────────────────

/**
 * 入队 create → submit → completed。链尾 = completed entry ID。
 */
export async function quizSubmittedViaOutbox(
  stageId: string | null | undefined, sceneId: string,
): Promise<'enqueued' | 'skipped' | 'disabled'> {
  if (!isQuizOutboxEnabled() || !stageId) return 'disabled';
  const envelope = readSubmittedEnvelope(sceneId);
  if (!envelope) return 'skipped';
  const sessionId = `qa:${stageId}:${sceneId}:${envelope.attemptId}`;
  const nowStr = new Date().toISOString();

  return db.transaction('rw', db.runtimeOutbox, db.succeededEntries, async () => {
    const createId = await _qEnqueue({
      kind: 'quizAttempt', op: 'create_session', sessionId,
      semanticKey: `quiz:create:${sessionId}`,
      body: { id: sessionId, kind: 'quizAttempt', stageId, status: 'active', createdAt: nowStr, updatedAt: nowStr },
    });
    const submitId = await _qEnqueue({
      kind: 'quizAttempt', op: 'append_record', sessionId,
      semanticKey: `quiz:submit:${sessionId}`,
      body: { id: `${sessionId}:submit`, createdAt: nowStr, sceneId,
        payload: { phase: 'submitted' as const, answers: envelope.answers } },
    }, createId);
    const completedId = await _qEnqueue({
      kind: 'quizAttempt', op: 'set_status', sessionId,
      semanticKey: `quiz:completed:${sessionId}`,   // distinct from archived
      body: { status: 'completed' as const, updatedAt: nowStr },
    }, submitId);
    await _setTailInTx(sessionId, completedId);
    return 'enqueued' as const;
  });
}

/**
 * 依赖当前链尾（completed），入队 reviewed。链尾 → reviewed。
 */
export async function quizReviewedViaOutbox(
  stageId: string | null | undefined, sceneId: string,
): Promise<'enqueued' | 'skipped' | 'disabled'> {
  if (!isQuizOutboxEnabled() || !stageId) return 'disabled';
  const envelope = readSubmittedEnvelope(sceneId);
  if (!envelope) return 'skipped';
  const results = readResults(sceneId);
  if (!results) return 'skipped';
  const sessionId = `qa:${stageId}:${sceneId}:${envelope.attemptId}`;
  const nowStr = new Date().toISOString();

  return db.transaction('rw', db.runtimeOutbox, db.succeededEntries, async () => {
    let tailId = await _getTailInTx(sessionId);
    if (!tailId) {
      // 无链尾 → 创建 create（session 可能由 reviewed 首次创建）
      tailId = await _qEnqueue({
        kind: 'quizAttempt', op: 'create_session', sessionId,
        semanticKey: `quiz:create:${sessionId}`,
        body: { id: sessionId, kind: 'quizAttempt', stageId, status: 'completed', createdAt: nowStr, updatedAt: nowStr },
      });
    }
    const gradeId = await _qEnqueue({
      kind: 'quizAttempt', op: 'append_record', sessionId,
      semanticKey: `quiz:grade:${sessionId}`,
      body: { id: `${sessionId}:grade`, createdAt: nowStr, sceneId,
        payload: { phase: 'reviewed' as const, answers: envelope.answers, results } },
    }, tailId);
    await _setTailInTx(sessionId, gradeId);
    return 'enqueued' as const;
  });
}

/**
 * 依赖当前链尾，入队 archived。链尾 → archived。
 * semanticKey 与 completed 不同，防止压缩。
 */
export async function quizRetryViaOutbox(
  stageId: string | null | undefined, sceneId: string,
): Promise<'enqueued' | 'skipped' | 'disabled'> {
  if (!isQuizOutboxEnabled() || !stageId) return 'disabled';
  const envelope = readSubmittedEnvelope(sceneId);
  if (!envelope?.attemptId) return 'skipped';
  const sessionId = `qa:${stageId}:${sceneId}:${envelope.attemptId}`;
  const nowStr = new Date().toISOString();

  return db.transaction('rw', db.runtimeOutbox, db.succeededEntries, async () => {
    const tailId = await _getTailInTx(sessionId);
    if (!tailId) return 'skipped' as const; // 无前序链 → 不发送独立的 archived
    const archivedId = await _qEnqueue({
      kind: 'quizAttempt', op: 'set_status', sessionId,
      semanticKey: `quiz:archived:${sessionId}`,   // distinct from completed
      body: { status: 'archived' as const, updatedAt: nowStr },
    }, tailId);
    await _setTailInTx(sessionId, archivedId);
    return 'enqueued' as const;
  });
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
  for (const e of existing) {
    await db.runtimeOutbox.update(e.id, { status: 'superseded' });
    await _qsDepsInTx(e.id);
  }
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

async function _qsDepsInTx(entryId: string): Promise<void> {
  const deps = await db.runtimeOutbox.where('dependsOnEntryId').equals(entryId)
    .filter((e) => e.status === 'pending' && !e.leaseOwner).toArray();
  for (const d of deps) {
    await db.runtimeOutbox.update(d.id, { status: 'superseded' });
    await _qsDepsInTx(d.id);
  }
}

export { resolveQuizEffectiveTime };
