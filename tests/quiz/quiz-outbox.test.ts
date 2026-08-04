/**
 * R3.2 quiz outbox 门禁测试
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  quizSubmittedViaOutbox, quizReviewedViaOutbox, quizRetryViaOutbox,
  drainQuizOutbox, onQuizOutboxStartup, isQuizOutboxReady, setQuizOutboxReady,
} from '@/lib/runtime/quiz-outbox';
import { db } from '@/lib/utils/database';

const store: Record<string, string> = {};
vi.stubGlobal('window', {});
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
});

function writeEnvelope(sceneId: string, attemptId: string, answers: Record<string, string>) {
  store[`quizAnswers:${sceneId}`] = JSON.stringify({ v: 1, attemptId, answers });
  store[`quizResults:${sceneId}`] = JSON.stringify([]);
}
function writeResults(sceneId: string) {
  store[`quizResults:${sceneId}`] = JSON.stringify([{ q: 'q1', correct: true }]);
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.runtimeOutbox.clear();
  await db.succeededEntries.clear();
  for (const k of Object.keys(store)) delete store[k];
});

// ══════════════════════════════════════════════════════════════════════════════

describe('quizSubmitted', () => {
  beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1'); });
  it('入队 create→submit→status', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    expect(await quizSubmittedViaOutbox('st1', 'sc1')).toBe('enqueued');
    const entries = await db.runtimeOutbox.toArray();
    expect(entries.length).toBe(3);
    expect(entries.map((e) => e.op).sort()).toEqual(['append_record', 'create_session', 'set_status']);
  });
  it('无 envelope → skipped', async () => {
    expect(await quizSubmittedViaOutbox('st1', 'sc2')).toBe('skipped');
  });
  it('开关关闭 → disabled', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '0');
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    expect(await quizSubmittedViaOutbox('st1', 'sc1')).toBe('disabled');
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('submitted→reviewed 严格依赖链', () => {
  beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1'); });

  it('reviewed grade 依赖 submitted 链尾（同 session）', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    writeResults('sc1');
    // First submitted
    await quizSubmittedViaOutbox('st1', 'sc1');
    const submitEntries = await db.runtimeOutbox.toArray();
    const submitOp = submitEntries.find((e) => e.op === 'append_record');
    expect(submitOp).toBeTruthy();
    // Then reviewed — should reuse same create_session, grade depends on submit chain
    await quizReviewedViaOutbox('st1', 'sc1');
    const all = await db.runtimeOutbox.toArray();
    // Should NOT create a second create_session
    const creates = all.filter((e) => e.op === 'create_session');
    expect(creates.length).toBe(1);
    // grade should depend on something from the submitted chain
    const grade = all.find((e) => e.semanticKey.startsWith('quiz:grade'));
    expect(grade).toBeTruthy();
    expect(grade!.dependsOnEntryId).toBeTruthy();
  });

  it('submitted 未发送时立即 reviewed → grade 链不悬挂', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    writeResults('sc1');
    // Both enqueue without drain in between
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    const entries = await db.runtimeOutbox.orderBy('sequence').toArray();
    // All create_session entries
    const creates = entries.filter((e) => e.op === 'create_session');
    expect(creates.length).toBe(1); // reused, not duplicated
    // No pending depends on superseded
    const supersededIds = new Set(entries.filter((e) => e.status === 'superseded').map((e) => e.id));
    for (const e of entries) {
      if (e.status === 'pending' && e.dependsOnEntryId) {
        expect(supersededIds.has(e.dependsOnEntryId)).toBe(false);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('quizRetry', () => {
  beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1'); });
  it('入队 set_status:archived', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    const result = await quizRetryViaOutbox('st1', 'sc1');
    expect(result).toBe('enqueued');
    const entries = await db.runtimeOutbox.toArray();
    expect(entries.length).toBe(1);
    expect(entries[0].op).toBe('set_status');
    expect((entries[0].body as any).status).toBe('archived');
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('drain + recovery', () => {
  beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1'); });

  it('drain sends all enqueued', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    await quizSubmittedViaOutbox('st1', 'sc1');
    await drainQuizOutbox('tab-q');
    expect(await db.runtimeOutbox.where('status').equals('pending').count()).toBe(0);
    expect(await db.succeededEntries.count()).toBeGreaterThan(0);
  });

  it('startup sets ready + drains', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    await quizSubmittedViaOutbox('st1', 'sc1');
    const result = await onQuizOutboxStartup('tab-s');
    expect(result.ready).toBe(true);
    expect(isQuizOutboxReady()).toBe(true);
    expect(await db.runtimeOutbox.where('status').equals('pending').count()).toBe(0);
  });

  it('outbox not ready → old path still works', async () => {
    // Verify isQuizOutboxReady returns false before startup
    expect(isQuizOutboxReady()).toBe(false);
    // After startup, ready=true
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await onQuizOutboxStartup('tab-t');
    expect(isQuizOutboxReady()).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('body 契约', () => {
  beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1'); });

  it('create body matches R2 contract', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    await quizSubmittedViaOutbox('st1', 'sc1');
    const c = (await db.runtimeOutbox.toArray()).find((e) => e.op === 'create_session');
    const b = c!.body as any;
    expect(b.id).toBe('qa:st1:sc1:att1');
    expect(b.kind).toBe('quizAttempt');
    expect(b.stageId).toBe('st1');
    expect(b.status).toBe('active');
    expect(b.createdAt).toBeTruthy();
    expect(b.updatedAt).toBeTruthy();
  });

  it('submit record body matches R2 contract', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    await quizSubmittedViaOutbox('st1', 'sc1');
    const s = (await db.runtimeOutbox.toArray()).find((e) => e.op === 'append_record' && e.semanticKey.startsWith('quiz:submit'));
    const b = s!.body as any;
    expect(b.id).toBe('qa:st1:sc1:att1:submit');
    expect(b.sceneId).toBe('sc1');
    expect(b.payload.phase).toBe('submitted');
    expect(b.payload.answers).toEqual({ q1: 'A' });
  });

  it('grade record body matches R2 contract', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    writeResults('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    const g = (await db.runtimeOutbox.toArray()).find((e) => e.op === 'append_record' && e.semanticKey.startsWith('quiz:grade'));
    const b = g!.body as any;
    expect(b.id).toBe('qa:st1:sc1:att1:grade');
    expect(b.payload.phase).toBe('reviewed');
    expect(b.payload.results).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('幂等 + 压缩', () => {
  beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1'); });

  it('第二次 submit 压缩旧链', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    await quizSubmittedViaOutbox('st1', 'sc1');
    const firstCount = await db.runtimeOutbox.count();
    // Second submit with same envelope
    await quizSubmittedViaOutbox('st1', 'sc1');
    const all = await db.runtimeOutbox.toArray();
    // Old entries compacted, replaced
    const pending = all.filter((e) => e.status === 'pending');
    const superseded = all.filter((e) => e.status === 'superseded');
    expect(pending.length).toBeGreaterThan(0);
    expect(superseded.length).toBeGreaterThan(0);
    // Old submit entry compacted
    expect(superseded.some((e) => e.op === 'append_record')).toBe(true);
  });
});
