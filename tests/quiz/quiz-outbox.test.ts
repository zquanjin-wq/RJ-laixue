/**
 * R3.2 quiz outbox 门禁测试
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  quizSubmittedViaOutbox, quizReviewedViaOutbox, quizRetryViaOutbox,
  drainQuizOutbox, onQuizOutboxStartup, isQuizOutboxReady, setQuizOutboxReady,
  resolveQuizEffectiveTime,
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

function enableSwitch() {
  vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
  vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ', '1');
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.runtimeOutbox.clear();
  await db.succeededEntries.clear();
  for (const k of Object.keys(store)) delete store[k];
});

// ══════════════════════════════════════════════════════════════════════════════

describe('双开关', () => {
  it('quiz 子开关关闭 → disabled，零 outbox', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ', '0');
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    expect(await quizSubmittedViaOutbox('st1', 'sc1')).toBe('disabled');
    expect(await db.runtimeOutbox.count()).toBe(0);
  });

  it('startup 子开关关闭 → ready=false', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ', '0');
    const r = await onQuizOutboxStartup();
    expect(r.ready).toBe(false);
    expect(isQuizOutboxReady()).toBe(false);
  });

  it('ready=1 后关闭子开关 → isQuizOutboxReady=false', async () => {
    enableSwitch();
    await onQuizOutboxStartup();
    expect(isQuizOutboxReady()).toBe(true);
    // Turn off sub-switch
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ', '0');
    expect(isQuizOutboxReady()).toBe(false);
    // Turn it back on
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ', '1');
    expect(isQuizOutboxReady()).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('quizSubmitted', () => {
  beforeEach(() => enableSwitch());
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
});

// ══════════════════════════════════════════════════════════════════════════════

describe('submit→reviewed 严格依赖', () => {
  beforeEach(() => enableSwitch());

  it('reviewed 依赖 submitId（submit 在 outbox）', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' }); writeResults('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    const all = await db.runtimeOutbox.toArray();
    const grade = all.find((e) => e.semanticKey.startsWith('quiz:grade'));
    expect(grade).toBeTruthy();
    // grade depends on submitId, not createId
    const submit = all.find((e) => e.semanticKey.startsWith('quiz:submit'));
    expect(grade!.dependsOnEntryId).toBe(submit!.id);
    // single create
    expect(all.filter((e) => e.op === 'create_session').length).toBe(1);
  });

  it('reviewed 依赖 submitId（submit 已发送、在 succeededEntries）', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' }); writeResults('sc1');
    // Submit → drain to send
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await quizSubmittedViaOutbox('st1', 'sc1');
    await drainQuizOutbox('tab-s');
    // Now submit is in succeededEntries
    // Reviewed should still depend on submitId (state machine checks succeededEntries)
    await quizReviewedViaOutbox('st1', 'sc1');
    const all = await db.runtimeOutbox.toArray();
    const grade = all.find((e) => e.semanticKey.startsWith('quiz:grade'));
    const chainEntry = JSON.parse(store[`r3:quiz:chain:qa:st1:sc1:att1`] || '{}');
    expect(grade!.dependsOnEntryId).toBe(chainEntry.submitId);
  });

  it('submit dead → reviewed 被级联 dead', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    writeEnvelope('sc1', 'att1', { q1: 'A' }); writeResults('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    const all1 = await db.runtimeOutbox.toArray();
    const submit = all1.find((e) => e.semanticKey.startsWith('quiz:submit'))!;
    // Mark submit dead
    await db.runtimeOutbox.update(submit.id, { status: 'dead' });
    await quizReviewedViaOutbox('st1', 'sc1');
    const grade = (await db.runtimeOutbox.toArray()).find((e) => e.semanticKey.startsWith('quiz:grade'))!;
    expect(grade.dependsOnEntryId).toBe(submit.id);
    // drain should cascade dead on grade (dequeueOne finds dead dep → cascade)
    await drainQuizOutbox('tab-d');
    const final = await db.runtimeOutbox.get(grade.id);
    expect(final!.status).toBe('dead');
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('quizRetry', () => {
  beforeEach(() => enableSwitch());
  it('入队 set_status:archived', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    expect(await quizRetryViaOutbox('st1', 'sc1')).toBe('enqueued');
    expect((await db.runtimeOutbox.toArray())[0].op).toBe('set_status');
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('drain + scheduler', () => {
  beforeEach(() => enableSwitch());

  it('drain sends + auto-reschedule', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    await quizSubmittedViaOutbox('st1', 'sc1');
    // Drain should finish + schedule next timer
    await drainQuizOutbox('tab-q');
    expect(await db.runtimeOutbox.where('status').equals('pending').count()).toBe(0);
  });

  it('三段链 create→submit→status：全部退避5min', async () => {
    const nowMs = Date.now();
    const fiveMin = new Date(nowMs + 5 * 60 * 1000).toISOString();
    const cId = crypto.randomUUID(), sId = crypto.randomUUID(), tId = crypto.randomUUID();
    await db.runtimeOutbox.bulkPut([
      { id: cId, kind: 'quizAttempt' as const, op: 'create_session' as const,
        sessionId: 'qa:cst', semanticKey: 'qc', body: {}, createdAt: new Date().toISOString(),
        attempts: 3, nextAttemptAt: fiveMin, status: 'pending' as const, sequence: 1 },
      { id: sId, kind: 'quizAttempt' as const, op: 'append_record' as const,
        sessionId: 'qa:cst', semanticKey: 'qs', body: {}, createdAt: new Date().toISOString(),
        attempts: 0, nextAttemptAt: new Date(nowMs).toISOString(), status: 'pending' as const, sequence: 2,
        dependsOnEntryId: cId },
      { id: tId, kind: 'quizAttempt' as const, op: 'set_status' as const,
        sessionId: 'qa:cst', semanticKey: 'qt', body: {}, createdAt: new Date().toISOString(),
        attempts: 0, nextAttemptAt: new Date(nowMs).toISOString(), status: 'pending' as const, sequence: 3,
        dependsOnEntryId: sId },
    ]);
    // Dynamically import the resolver (not exported, but testable via scheduleNextQuizDrain's logic)
    // Use the fact that resolveQuizEffectiveTime walks the full chain
    const { resolveQuizEffectiveTime } = await import('@/lib/runtime/quiz-outbox');
    // Test status (3rd level) resolves to create's 5min
    const status = (await db.runtimeOutbox.toArray()).find((e) => e.op === 'set_status')!;
    const resolved = await resolveQuizEffectiveTime(status);
    expect(resolved - nowMs).toBeGreaterThan(4.5 * 60 * 1000);
    expect(resolved - nowMs).toBeLessThan(5.5 * 60 * 1000);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('startup', () => {
  beforeEach(() => enableSwitch());
  it('startup drains + sets ready', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    await quizSubmittedViaOutbox('st1', 'sc1');
    const r = await onQuizOutboxStartup('tab-s');
    expect(r.ready).toBe(true);
    expect(isQuizOutboxReady()).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('body 契约', () => {
  beforeEach(() => enableSwitch());
  it('create body', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    await quizSubmittedViaOutbox('st1', 'sc1');
    const b = ((await db.runtimeOutbox.toArray()).find((e) => e.op === 'create_session')!).body as any;
    expect(b.id).toBe('qa:st1:sc1:att1'); expect(b.kind).toBe('quizAttempt');
  });
  it('submit body', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    await quizSubmittedViaOutbox('st1', 'sc1');
    const s = (await db.runtimeOutbox.toArray()).find((e) => e.semanticKey.startsWith('quiz:submit'))!;
    const b = s.body as any;
    expect(b.id).toBe('qa:st1:sc1:att1:submit'); expect(b.payload.phase).toBe('submitted');
  });
  it('grade body', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' }); writeResults('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    const g = (await db.runtimeOutbox.toArray()).find((e) => e.semanticKey.startsWith('quiz:grade'))!;
    expect((g.body as any).payload.phase).toBe('reviewed');
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('compaction', () => {
  beforeEach(() => enableSwitch());
  it('第二次 submit 压缩旧链', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    const s = (await db.runtimeOutbox.toArray()).filter((e) => e.status === 'superseded');
    expect(s.length).toBeGreaterThan(0);
    expect(s.some((e) => e.op === 'append_record')).toBe(true);
  });
});
