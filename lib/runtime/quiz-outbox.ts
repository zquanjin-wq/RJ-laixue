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

// ─── 链尾（Dexie runtimeChainHeads，与 outbox 同事务）─────────────────────

async function _getTailInTx(sessionId: string): Promise<string | undefined> {
  const row = await db.runtimeChainHeads.get(sessionId);
  return row?.tailEntryId;
}

async function _setTailInTx(sessionId: string, entryId: string): Promise<void> {
  await db.runtimeChainHeads.put({ sessionId, tailEntryId: entryId, updatedAt: new Date().toISOString() });
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

// ─── Quiz phase 识别 ─────────────────────────────────────────────────────────

type QuizPhase = 'create' | 'submit' | 'reviewed' | 'completed' | 'archived';

const QUIZ_PHASE_ORDER: Record<QuizPhase, number> = {
  create: 0,
  submit: 1,
  reviewed: 2,
  completed: 3,
  archived: 4,
};

function quizPhaseOf(entry: RuntimeOutboxEntry): QuizPhase | null {
  const k = entry.semanticKey;
  if (k.startsWith('quiz:create:')) return 'create';
  if (k.startsWith('quiz:submit:')) return 'submit';
  if (k.startsWith('quiz:grade:')) return 'reviewed';
  if (k.startsWith('quiz:completed:')) return 'completed';
  if (k.startsWith('quiz:archived:')) return 'archived';
  return null;
}

// ─── 领域错误 ────────────────────────────────────────────────────────────────

export class QuizSubmissionMismatchError extends Error {
  constructor(sessionId: string) {
    super(`Quiz submission payload mismatch for session ${sessionId}`);
    this.name = 'QuizSubmissionMismatchError';
  }
}

export class QuizSubmissionBlockedError extends Error {
  constructor(sessionId: string, reason: string) {
    super(`Quiz submission blocked for session ${sessionId}: ${reason}`);
    this.name = 'QuizSubmissionBlockedError';
  }
}

export class QuizSubmissionCorruptError extends Error {
  constructor(sessionId: string, detail: string) {
    super(`Quiz submission corrupt state for session ${sessionId}: ${detail}`);
    this.name = 'QuizSubmissionCorruptError';
  }
}

// ─── canonical payload 比较 ──────────────────────────────────────────────────

/**
 * 稳定序列化：对象 key 排序后递归序列化，使「key 顺序不同但语义相同」的对象
 * 得到相同字符串。客户端生成时间（createdAt）不参与比较——它不属于业务身份。
 */
function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 新建 submit 的 canonical 表示：只含业务身份字段（sceneId / phase / answers）。 */
function canonicalSubmitBody(sceneId: string, answers: unknown): string {
  return stableStringify({ sceneId, phase: 'submitted', answers });
}

/** 从已持久化的 submit body 提取业务身份字段后做 canonical 表示（排除 createdAt / id）。 */
function canonicalizeStoredSubmitBody(body: unknown): string {
  const b = body as { sceneId?: unknown; payload?: { phase?: unknown; answers?: unknown } };
  return stableStringify({ sceneId: b?.sceneId, phase: b?.payload?.phase, answers: b?.payload?.answers });
}

// ─── 公开 API — 严格链 ──────────────────────────────────────────────────────

/**
 * R3.2 E2E 修正（2026-08-04）：服务端 completed 后禁止追加 record（409 INACTIVE_SESSION）。
 * 新链顺序：create → submitted → reviewed → completed → archived
 * - submitted: 入队 create → submit
 * - reviewed: 依赖链尾（submit）入队 grade → set_status completed
 * - retry: 依赖链尾（completed）入队 set_status archived
 *
 * R3.2 原子幂等（2026-08-21）：同一个 attempt 的 submitted 幂等判定与入队在
 * 同一个 Dexie rw 事务内完成，覆盖状态 A–G（见实施报告）。同一 attempt 无论
 * 刷新、重复调用或跨标签页并发，只拥有一套 create/submitted 链，chain head 不回退。
 */
export async function quizSubmittedViaOutbox(
  stageId: string | null | undefined, sceneId: string,
): Promise<'enqueued' | 'skipped' | 'disabled'> {
  if (!isQuizOutboxEnabled() || !stageId) return 'disabled';
  const envelope = readSubmittedEnvelope(sceneId);
  if (!envelope) return 'skipped';
  const sessionId = `qa:${stageId}:${sceneId}:${envelope.attemptId}`;
  const nowStr = new Date().toISOString();
  const createKey = `quiz:create:${sessionId}`;
  const submitKey = `quiz:submit:${sessionId}`;

  return db.transaction('rw', db.runtimeOutbox, db.runtimeChainHeads, db.succeededEntries, async () => {
    const entries = await db.runtimeOutbox.where('sessionId').equals(sessionId).toArray();
    const head = await db.runtimeChainHeads.get(sessionId);
    const succIds = new Set((await db.succeededEntries.toArray()).map((s) => s.entryId));

    const isActive = (e: RuntimeOutboxEntry) => e.status === 'pending' || e.status === 'sending';
    const activeCreate = entries.find((e) => e.semanticKey === createKey && isActive(e));
    const activeSubmit = entries.find((e) => e.semanticKey === submitKey && isActive(e));

    const headEntry = head ? entries.find((e) => e.id === head.tailEntryId) : undefined;
    const headPhase = headEntry ? quizPhaseOf(headEntry) : null;
    const headSucceeded = head ? succIds.has(head.tailEntryId) : false;

    // E：相同 attempt、不同持久化 payload → 抛领域错误，事务零写入。
    // 必须最先检查：即使 reviewed/completed 已入队（后续阶段活跃），只要存在 active
    // submitted 且 payload 已漂移，也必须抛 mismatch，而非落入状态 D 幂等空转。
    if (activeSubmit) {
      const expected = canonicalSubmitBody(sceneId, envelope.answers);
      const actual = canonicalizeStoredSubmitBody(activeSubmit.body);
      if (expected !== actual) throw new QuizSubmissionMismatchError(sessionId);
    }

    // B：相同提交仍为 pending/sending → 复用现有 entry，不新建、不 supersede、不回写 head。
    // 同时验证 dependency 一致性：activeSubmit 必须精确依赖 activeCreate。
    if (activeCreate && activeSubmit) {
      if (activeSubmit.dependsOnEntryId !== activeCreate.id) {
        throw new QuizSubmissionCorruptError(sessionId, 'create/submit dependency mismatch');
      }
      return 'enqueued' as const;
    }

    // D：chain 已进入后续阶段（reviewed/completed/archived 活跃，或 head 已是后续阶段）→ 幂等空转，不回退
    const laterActive = entries.some((e) => {
      const p = quizPhaseOf(e);
      return p !== null && QUIZ_PHASE_ORDER[p] >= QUIZ_PHASE_ORDER.reviewed && isActive(e);
    });
    if (laterActive || (headPhase !== null && QUIZ_PHASE_ORDER[headPhase] >= QUIZ_PHASE_ORDER.reviewed)) {
      return 'enqueued' as const;
    }

    // F：create/submit 已 dead（被级联终结）→ 不得用同一 attemptId 静默重建
    const terminated = entries.find(
      (e) => (e.semanticKey === createKey || e.semanticKey === submitKey) && e.status === 'dead',
    );
    if (terminated) throw new QuizSubmissionBlockedError(sessionId, 'prior submission terminated');

    // F'：孤立 superseded（无 active successor、无成功凭据、无后续链）→ 禁止同 attempt 重建
    const orphanSuperseded = entries.find(
      (e) => (e.semanticKey === createKey || e.semanticKey === submitKey) && e.status === 'superseded',
    );
    if (orphanSuperseded && !headSucceeded) {
      throw new QuizSubmissionBlockedError(sessionId, 'prior submission superseded without successor');
    }

    // C：create/submit 已成功（head 指向的 entry 已持有成功凭据）→ 幂等空转
    if (head && headSucceeded) return 'enqueued' as const;

    // G：异常部分状态 → 不猜测、不拼接，返回明确错误保留现场
    if (activeSubmit && !activeCreate) throw new QuizSubmissionCorruptError(sessionId, 'submit without create');
    if (activeCreate && !activeSubmit) throw new QuizSubmissionCorruptError(sessionId, 'create without submit');
    if (head && !headEntry && !headSucceeded) throw new QuizSubmissionCorruptError(sessionId, 'chain head points to missing entry');

    // A：全新 attempt → 同事务创建 create + submit，head 指向 submit
    const createId = await _qEnqueueRaw({
      op: 'create_session', sessionId, semanticKey: createKey,
      body: { id: sessionId, kind: 'quizAttempt', stageId, status: 'active', createdAt: nowStr, updatedAt: nowStr },
    }, undefined, entries);
    const submitId = await _qEnqueueRaw({
      op: 'append_record', sessionId, semanticKey: submitKey,
      body: { id: `${sessionId}:submit`, createdAt: nowStr, sceneId,
        payload: { phase: 'submitted' as const, answers: envelope.answers } },
    }, createId, entries);
    // 链尾停在 submit——completed 由 reviewed 触发的 grade 成功后一起 set
    await _setTailInTx(sessionId, submitId);
    return 'enqueued' as const;
  });
}

/**
 * reviewed 入队 grade（依赖 submit 链尾），grade 成功后 set_status completed。
 * 两步原子入队，确保服务端 send 顺序：grade → completed（不再被服务端拒绝）。
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

  return db.transaction('rw', db.runtimeOutbox, db.runtimeChainHeads, async () => {
    let tailId = await _getTailInTx(sessionId);
    if (!tailId) {
      // 极少见：reviewed 先于 submitted 触发（user 立即批改）。补建 create+submit。
      const newCreate = await _qEnqueue({
        kind: 'quizAttempt', op: 'create_session', sessionId,
        semanticKey: `quiz:create:${sessionId}`,
        body: { id: sessionId, kind: 'quizAttempt', stageId, status: 'active', createdAt: nowStr, updatedAt: nowStr },
      });
      tailId = await _qEnqueue({
        kind: 'quizAttempt', op: 'append_record', sessionId,
        semanticKey: `quiz:submit:${sessionId}`,
        body: { id: `${sessionId}:submit`, createdAt: nowStr, sceneId,
          payload: { phase: 'submitted' as const, answers: envelope.answers } },
      }, newCreate);
    }
    // grade 依赖链尾
    const gradeId = await _qEnqueue({
      kind: 'quizAttempt', op: 'append_record', sessionId,
      semanticKey: `quiz:grade:${sessionId}`,
      body: { id: `${sessionId}:grade`, createdAt: nowStr, sceneId,
        payload: { phase: 'reviewed' as const, answers: envelope.answers, results } },
    }, tailId);
    // completed 紧随 grade（链尾指向 completed）
    const completedId = await _qEnqueue({
      kind: 'quizAttempt', op: 'set_status', sessionId,
      semanticKey: `quiz:completed:${sessionId}`,
      body: { status: 'completed' as const, updatedAt: nowStr },
    }, gradeId);
    await _setTailInTx(sessionId, completedId);
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

  return db.transaction('rw', db.runtimeOutbox, db.runtimeChainHeads, async () => {
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

/**
 * 纯净入队：不 supersede、不去重（幂等判定由调用方在同一 rw 事务内完成）。
 * sequence 取 entriesInTx 中最大值 +1，避免 superseded/dead 行占位产生间隙。
 */
async function _qEnqueueRaw(
  params: { op: RuntimeOutboxEntry['op']; sessionId: string; semanticKey: string; body: unknown },
  dependsOnEntryId: string | undefined,
  entriesInTx: RuntimeOutboxEntry[],
): Promise<string> {
  const id = crypto.randomUUID();
  const nowStr = new Date().toISOString();
  const lastSeq = entriesInTx.length > 0 ? Math.max(...entriesInTx.map((e) => e.sequence ?? 0)) : 0;
  const entry: RuntimeOutboxEntry = {
    id, kind: 'quizAttempt', op: params.op,
    sessionId: params.sessionId, semanticKey: params.semanticKey,
    body: params.body, createdAt: nowStr, attempts: 0, nextAttemptAt: nowStr,
    status: 'pending', sequence: lastSeq + 1, dependsOnEntryId,
  };
  await db.runtimeOutbox.put(entry);
  entriesInTx.push(entry);
  return id;
}

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
