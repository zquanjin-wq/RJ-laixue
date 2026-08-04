/**
 * R3.2 quiz outbox 门禁测试
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quizSubmittedViaOutbox, quizReviewedViaOutbox, quizRetryViaOutbox, drainQuizOutbox } from '@/lib/runtime/quiz-outbox';
import { db } from '@/lib/utils/database';

// Mock localStorage for quiz envelope
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

function writeResults(sceneId: string, results: unknown[]) {
  store[`quizResults:${sceneId}`] = JSON.stringify(results);
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
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
  });

  it('入队 create→submit→status', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    const result = await quizSubmittedViaOutbox('st1', 'sc1');
    expect(result).toBe('enqueued');
    const entries = await db.runtimeOutbox.toArray();
    expect(entries.length).toBe(3);
    expect(entries.map((e) => e.op).sort()).toEqual(['append_record', 'create_session', 'set_status']);
  });

  it('无 envelope → skipped', async () => {
    expect(await quizSubmittedViaOutbox('st1', 'sc2')).toBe('skipped');
    expect(await db.runtimeOutbox.count()).toBe(0);
  });

  it('开关关闭 → disabled', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '0');
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    expect(await quizSubmittedViaOutbox('st1', 'sc1')).toBe('disabled');
    vi.unstubAllEnvs();
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('quizReviewed', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
  });

  it('入队 create→grade', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    writeResults('sc1', [{ questionId: 'q1', correct: true }]);
    const result = await quizReviewedViaOutbox('st1', 'sc1');
    expect(result).toBe('enqueued');
    const entries = await db.runtimeOutbox.toArray();
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.op).sort()).toEqual(['append_record', 'create_session']);
    const grade = entries.find((e) => e.op === 'append_record');
    const body = grade!.body as any;
    expect(body.payload.phase).toBe('reviewed');
    expect(body.payload.results).toBeTruthy();
  });

  it('无结果 → skipped', async () => {
    writeEnvelope('sc2', 'att2', { q1: 'A' });
    expect(await quizReviewedViaOutbox('st1', 'sc2')).toBe('skipped');
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('quizRetry', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
  });

  it('入队 set_status:archived', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    const result = await quizRetryViaOutbox('st1', 'sc1');
    expect(result).toBe('enqueued');
    const entries = await db.runtimeOutbox.toArray();
    expect(entries.length).toBe(1);
    expect(entries[0].op).toBe('set_status');
    expect((entries[0].body as any).status).toBe('archived');
  });

  it('无 attemptId → skipped', async () => {
    expect(await quizRetryViaOutbox('st1', 'sc2')).toBe('skipped');
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('drain', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
  });

  it('drain sends all enqueued entries', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    await quizSubmittedViaOutbox('st1', 'sc1');
    await drainQuizOutbox('tab-q');
    expect(await db.runtimeOutbox.where('status').equals('pending').count()).toBe(0);
    expect(await db.succeededEntries.count()).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('依赖链', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
  });

  it('submit→grade→status 正确依赖链', async () => {
    writeEnvelope('sc1', 'att1', { q1: 'A' });
    writeResults('sc1', [{ questionId: 'q1', correct: true }]);
    // First submitted (create→submit→status), then reviewed (create→grade)
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    const entries = await db.runtimeOutbox.orderBy('sequence').toArray();
    expect(entries.length).toBe(5);
    // submitted chain: create→submit→status (seq 1-3)
    // reviewed chain: create→grade (seq 4-5)
    const submits = entries.filter((e) => e.semanticKey.startsWith('quiz:submit'));
    expect(submits.length).toBe(1);
    const grades = entries.filter((e) => e.semanticKey.startsWith('quiz:grade'));
    expect(grades.length).toBe(1);
    expect(grades[0].dependsOnEntryId).toBeTruthy();
  });
});
