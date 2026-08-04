/**
 * lib/runtime/quiz-outbox.ts
 *
 * R3.2: quizAttempt shadow write → outbox mode.
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

// ─── 开关 ────────────────────────────────────────────────────────────────────

export function isQuizOutboxEnabled(): boolean {
  return isRuntimeShadowEnabled() && process.env.NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ === '1';
}

// ─── outboxReady 门禁 ────────────────────────────────────────────────────────

const QUIZ_READY_KEY = 'r3:quiz:outbox:ready';

export function isQuizOutboxReady(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(QUIZ_READY_KEY) === '1';
}

export function setQuizOutboxReady(): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(QUIZ_READY_KEY, '1');
}

// ─── drain ───────────────────────────────────────────────────────────────────

let quizDrainRunning = false;
let quizDrainTimer: ReturnType<typeof setTimeout> | null = null;

async function scheduleNextQuizDrain(): Promise<void> {
  if (quizDrainTimer) { clearTimeout(quizDrainTimer); quizDrainTimer = null; }
  if (!isQuizOutboxEnabled()) return;
  const pending = await db.runtimeOutbox
    .where('kind').equals('quizAttempt')
    .filter((e) => e.status === 'pending')
    .toArray();
  if (pending.length === 0) return;
  // 复用 R3.1 依赖链解析逻辑——沿 dependsOnEntryId 找到根阻断时间
  const timesPromises = pending.map(async (e) => {
    if (!e.dependsOnEntryId) return new Date(e.nextAttemptAt).getTime();
    const dep = await db.runtimeOutbox.get(e.dependsOnEntryId);
    if (!dep) return new Date(e.nextAttemptAt).getTime();
    if (dep.status === 'sending' && dep.leaseUntil) {
      return Math.max(new Date(e.nextAttemptAt).getTime(), new Date(dep.leaseUntil).getTime());
    }
    if (dep.status === 'pending') {
      return Math.max(new Date(e.nextAttemptAt).getTime(), new Date(dep.nextAttemptAt).getTime());
    }
    return new Date(e.nextAttemptAt).getTime();
  });
  const times = await Promise.all(timesPromises);
  const earliest = Math.min(...times);
  const delay = Math.max(1000, earliest - Date.now()) + 50;
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

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * R3.2: 替代 shadowQuizSubmitted。
 * 入队 create → submit → status(completed)，并记录链尾 ID 供 reviewed 续接。
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
    // create — 使用确定性 semKey 防重复
    const createId = await _qEnqueue({
      kind: 'quizAttempt', op: 'create_session', sessionId,
      semanticKey: `quiz:create:${sessionId}`,
      body: { id: sessionId, kind: 'quizAttempt', stageId, status: 'active', createdAt: nowStr, updatedAt: nowStr },
    });
    // submit record — depends on create
    const submitId = await _qEnqueue({
      kind: 'quizAttempt', op: 'append_record', sessionId,
      semanticKey: `quiz:submit:${sessionId}`,
      body: {
        id: `${sessionId}:submit`, createdAt: nowStr, sceneId,
        payload: { phase: 'submitted' as const, answers: envelope.answers },
      },
    }, createId);
    // set_status completed — depends on submit
    await _qEnqueue({
      kind: 'quizAttempt', op: 'set_status', sessionId,
      semanticKey: `quiz:status:${sessionId}`,
      body: { status: 'completed' as const, updatedAt: nowStr },
    }, submitId);

    // 记录链尾用于 reviewed 续接
    _setChainTail(sessionId, submitId, createId);
    return 'enqueued' as const;
  });
}

/**
 * R3.2: 替代 shadowQuizReviewed。
 * 必须续接 submitted 链：复用同一 create_session，grade 依赖 submitted 链尾。
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
    const chainInfo = _getChainTail(sessionId);
    // grade 始终依赖 submitId——不绕过提交结果。
    // submit 在 outbox → 等待；在 succeededEntries → 通用状态机放行；
    // dead/superseded/lost → 状态机级联阻止 reviewed。
    let gradeDepId: string | undefined = chainInfo?.submitId ?? chainInfo?.createId;

    // ensure create exists (fallback — only when no chain info at all)
    if (!gradeDepId) {
      const existingCreate = await db.runtimeOutbox
        .where('semanticKey').equals(`quiz:create:${sessionId}`)
        .filter((e) => e.status !== 'superseded' && e.status !== 'dead')
        .first();
      if (!existingCreate) {
        gradeDepId = await _qEnqueue({
          kind: 'quizAttempt', op: 'create_session', sessionId,
          semanticKey: `quiz:create:${sessionId}`,
          body: { id: sessionId, kind: 'quizAttempt', stageId, status: 'completed', createdAt: nowStr, updatedAt: nowStr },
        });
      } else {
        gradeDepId = existingCreate.id;
      }
    }

    await _qEnqueue({
      kind: 'quizAttempt', op: 'append_record', sessionId,
      semanticKey: `quiz:grade:${sessionId}`,
      body: {
        id: `${sessionId}:grade`, createdAt: nowStr, sceneId,
        payload: { phase: 'reviewed' as const, answers: envelope.answers, results },
      },
    }, gradeDepId);

    return 'enqueued' as const;
  });
}

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

// ─── 链尾追踪（用于 reviewed 续接 submitted 链）─────────────────────────────

const CHAIN_KEY_PREFIX = 'r3:quiz:chain:';

function _setChainTail(sessionId: string, submitId: string, createId: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(CHAIN_KEY_PREFIX + sessionId, JSON.stringify({ submitId, createId }));
}

function _getChainTail(sessionId: string): { submitId?: string; createId?: string } | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CHAIN_KEY_PREFIX + sessionId);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
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
    .filter((e) => e.status === 'pending' && !e.leaseOwner)
    .toArray();
  for (const d of deps) {
    await db.runtimeOutbox.update(d.id, { status: 'superseded' });
    await _qsDepsInTx(d.id);
  }
}
