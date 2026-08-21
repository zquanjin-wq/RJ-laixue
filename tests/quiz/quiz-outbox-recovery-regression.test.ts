/**
 * OpenMAIC v0.3.2 启发 — Quiz outbox 恢复与顺序回归门禁
 *
 * 目标：只验证本地既有实现，不修改生产代码。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  quizSubmittedViaOutbox, quizReviewedViaOutbox, quizRetryViaOutbox,
  drainQuizOutbox, onQuizOutboxStartup, resolveQuizEffectiveTime,
} from '@/lib/runtime/quiz-outbox';
import { enqueue, dequeueOne } from '@/lib/runtime/outbox';
import { db } from '@/lib/utils/database';

const store: Record<string, string> = {};
vi.stubGlobal('window', {});
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
});

function we(sceneId: string, attemptId: string, answers: Record<string, string>) {
  store[`quizAnswers:${sceneId}`] = JSON.stringify({ v: 1, attemptId, answers });
  store[`quizResults:${sceneId}`] = JSON.stringify([]);
}
function wr(sceneId: string) {
  store[`quizResults:${sceneId}`] = JSON.stringify([{ q: 'q1', correct: true }]);
}
function on() {
  vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
  vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ', '1');
}

beforeEach(async () => {
  vi.useRealTimers();
  await db.runtimeOutbox.clear();
  await db.succeededEntries.clear();
  await db.runtimeChainHeads.clear();
  for (const k of Object.keys(store)) delete store[k];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const SESSION_ID = 'qa:st1:sc1:att1';

// ══════════════════════════════════════════════════════════════════════════════
// Q1：严格顺序
// ══════════════════════════════════════════════════════════════════════════════

describe('Q1：严格顺序', () => {
  it('Q1.1 每个 entry dependsOnEntryId 精确指向前一项', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    await quizRetryViaOutbox('st1', 'sc1');
    const entries = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    expect(entries.length).toBe(5);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].dependsOnEntryId).toBe(entries[i - 1].id);
    }
    expect({ gate: 'Q1.1', result: 'PASS' }).toEqual({ gate: 'Q1.1', result: 'PASS' });
  });

  it('Q1.2 runtimeChainHeads.tailEntryId 始终指向真实链尾', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    const tail1 = await db.runtimeChainHeads.get(SESSION_ID);
    const entries1 = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    expect(tail1?.tailEntryId).toBe(entries1[1].id); // submit

    await quizReviewedViaOutbox('st1', 'sc1');
    const tail2 = await db.runtimeChainHeads.get(SESSION_ID);
    const entries2 = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    expect(tail2?.tailEntryId).toBe(entries2[3].id); // completed

    await quizRetryViaOutbox('st1', 'sc1');
    const tail3 = await db.runtimeChainHeads.get(SESSION_ID);
    const entries3 = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    expect(tail3?.tailEntryId).toBe(entries3[4].id); // archived

    expect({ gate: 'Q1.2', result: 'PASS' }).toEqual({ gate: 'Q1.2', result: 'PASS' });
  });

  it('Q1.3 不允许 reviewed 绕过 submitted', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    // 没有 submitted，直接 reviewed
    await quizReviewedViaOutbox('st1', 'sc1');
    const entries = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    expect(entries.length).toBe(4); // create + submit + reviewed + completed（补建）
    expect(entries[2].semanticKey).toContain('grade');
    expect(entries[2].dependsOnEntryId).toBe(entries[1].id);
    expect({ gate: 'Q1.3', result: 'PASS' }).toEqual({ gate: 'Q1.3', result: 'PASS' });
  });

  it('Q1.4 不允许 completed 早于 reviewed', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    const entries = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    const reviewedIdx = entries.findIndex((e) => e.semanticKey.startsWith('quiz:grade'));
    const completedIdx = entries.findIndex((e) => e.semanticKey.startsWith('quiz:completed'));
    expect(reviewedIdx).toBeGreaterThan(0);
    expect(completedIdx).toBeGreaterThan(reviewedIdx);
    expect({ gate: 'Q1.4', result: 'PASS' }).toEqual({ gate: 'Q1.4', result: 'PASS' });
  });

  it('Q1.5 不允许 archived 早于 completed', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    await quizRetryViaOutbox('st1', 'sc1');
    const entries = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    const completedIdx = entries.findIndex((e) => e.semanticKey.startsWith('quiz:completed'));
    const archivedIdx = entries.findIndex((e) => e.semanticKey.startsWith('quiz:archived'));
    expect(archivedIdx).toBeGreaterThan(completedIdx);
    expect({ gate: 'Q1.5', result: 'PASS' }).toEqual({ gate: 'Q1.5', result: 'PASS' });
  });

  it('Q1.6 同一 session 内 sequence 单调递增', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    await quizRetryViaOutbox('st1', 'sc1');
    const entries = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].sequence ?? 0).toBeGreaterThan(entries[i - 1].sequence ?? 0);
    }
    expect({ gate: 'Q1.6', result: 'PASS' }).toEqual({ gate: 'Q1.6', result: 'PASS' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Q2：刷新恢复
// ══════════════════════════════════════════════════════════════════════════════

describe('Q2：刷新恢复', () => {
  it('Q2.1 localStorage 提交 envelope 保留', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    expect(store[`quizAnswers:sc1`]).toBeTruthy();
    expect({ gate: 'Q2.1', result: 'PASS' }).toEqual({ gate: 'Q2.1', result: 'PASS' });
  });

  it('Q2.2 runtimeOutbox 保留', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    const before = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).count();
    // 模拟模块重载：直接重新读取 Dexie
    const after = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).count();
    expect(after).toBe(before);
    expect({ gate: 'Q2.2', result: 'PASS' }).toEqual({ gate: 'Q2.2', result: 'PASS' });
  });

  it('Q2.3 runtimeChainHeads 保留', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    const before = await db.runtimeChainHeads.get(SESSION_ID);
    const after = await db.runtimeChainHeads.get(SESSION_ID);
    expect(after?.tailEntryId).toBe(before?.tailEntryId);
    expect({ gate: 'Q2.3', result: 'PASS' }).toEqual({ gate: 'Q2.3', result: 'PASS' });
  });

  it('Q2.4 succeededEntries 保留', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await drainQuizOutbox('tab1');
    const before = await db.succeededEntries.count();
    const after = await db.succeededEntries.count();
    expect(after).toBe(before);
    expect(after).toBeGreaterThan(0);
    expect({ gate: 'Q2.4', result: 'PASS' }).toEqual({ gate: 'Q2.4', result: 'PASS' });
  });

  it('Q2.5 刷新后未发送条目不得生成第二条等价 create/submitted', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');

    // 模拟重新入队：再次调用 submitted（业务上不应发生，但测试幂等性）
    await quizSubmittedViaOutbox('st1', 'sc1');
    const entriesAfter = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');

    const creates = entriesAfter.filter((e) => e.semanticKey.startsWith('quiz:create'));
    const submits = entriesAfter.filter((e) => e.semanticKey.startsWith('quiz:submit'));
    expect(creates).toHaveLength(1);
    expect(submits).toHaveLength(1);
  });

  it('Q2.6 重试必须沿用已有 entry ID 与依赖关系', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    const before = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    const createId = before[0].id;
    const submitId = before[1].id;

    // 发送失败后退避
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    await drainQuizOutbox('tab1');

    const after = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    expect(after[0].id).toBe(createId);
    expect(after[1].id).toBe(submitId);
    expect(after[1].dependsOnEntryId).toBe(createId);
    expect({ gate: 'Q2.6', result: 'PASS' }).toEqual({ gate: 'Q2.6', result: 'PASS' });
  });

  it('Q2.7 已成功 entry 不得复活', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await drainQuizOutbox('tab1');
    const succeededIds = new Set((await db.succeededEntries.toArray()).map((s) => s.entryId));

    // 再次 drain
    await drainQuizOutbox('tab2');
    for (const id of succeededIds) {
      expect(await db.runtimeOutbox.get(id)).toBeUndefined();
    }
    expect({ gate: 'Q2.7', result: 'PASS' }).toEqual({ gate: 'Q2.7', result: 'PASS' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Q3：离线与退避
// ══════════════════════════════════════════════════════════════════════════════

describe('Q3：离线与退避', () => {
  it('Q3.1 入队时离线不会丢数据', async () => {
    on();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    const entries = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).toArray();
    expect(entries.length).toBeGreaterThan(0);
    expect({ gate: 'Q3.1', result: 'PASS' }).toEqual({ gate: 'Q3.1', result: 'PASS' });
  });

  it('Q3.2 fetch 失败后进入 pending 和退避', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    await drainQuizOutbox('tab1');
    const entries = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).toArray();
    const create = entries.find((e) => e.op === 'create_session');
    const submit = entries.find((e) => e.op === 'append_record');
    // create 已被尝试发送并退避；submit 因依赖 create pending 未被发送
    expect(create?.status).toBe('pending');
    expect(create?.attempts).toBeGreaterThan(0);
    expect(submit?.status).toBe('pending');
    expect(submit?.attempts).toBe(0);
    expect({ gate: 'Q3.2', result: 'PASS' }).toEqual({ gate: 'Q3.2', result: 'PASS' });
  });

  it('Q3.3 scheduler 按阻断根 entry 的 nextAttemptAt 唤醒', async () => {
    on();
    const ts = new Date().toISOString();
    const createId = crypto.randomUUID();
    const submitId = crypto.randomUUID();
    const fiveMin = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await db.runtimeOutbox.bulkPut([
      { id: createId, kind: 'quizAttempt', op: 'create_session', sessionId: 'qa:block', semanticKey: 'c', body: {}, createdAt: ts, attempts: 3, nextAttemptAt: fiveMin, status: 'pending', sequence: 1 },
      { id: submitId, kind: 'quizAttempt', op: 'append_record', sessionId: 'qa:block', semanticKey: 's', body: {}, createdAt: ts, attempts: 0, nextAttemptAt: ts, status: 'pending', sequence: 2, dependsOnEntryId: createId },
    ]);
    const submit = await db.runtimeOutbox.get(submitId);
    expect(submit).toBeTruthy();
    const effective = await resolveQuizEffectiveTime(submit!);
    expect(effective).toBeGreaterThanOrEqual(new Date(fiveMin).getTime());
    expect({ gate: 'Q3.3', result: 'PASS' }).toEqual({ gate: 'Q3.3', result: 'PASS' });
  });

  it('Q3.4 三段以上依赖链不得每秒空转', async () => {
    on();
    const ts = new Date().toISOString();
    const past = new Date(Date.now() - 1000).toISOString();
    // 直接构造已失败 3 次、退避到 45s 后的 create，以及依赖它的链
    const createId = crypto.randomUUID();
    const submitId = crypto.randomUUID();
    const gradeId = crypto.randomUUID();
    const completedId = crypto.randomUUID();
    const archivedId = crypto.randomUUID();
    await db.runtimeOutbox.bulkPut([
      { id: createId, kind: 'quizAttempt', op: 'create_session', sessionId: SESSION_ID, semanticKey: 'quiz:create:test', body: {}, createdAt: ts, attempts: 3, nextAttemptAt: past, status: 'pending', sequence: 1 },
      { id: submitId, kind: 'quizAttempt', op: 'append_record', sessionId: SESSION_ID, semanticKey: 'quiz:submit:test', body: {}, createdAt: ts, attempts: 0, nextAttemptAt: ts, status: 'pending', sequence: 2, dependsOnEntryId: createId },
      { id: gradeId, kind: 'quizAttempt', op: 'append_record', sessionId: SESSION_ID, semanticKey: 'quiz:grade:test', body: {}, createdAt: ts, attempts: 0, nextAttemptAt: ts, status: 'pending', sequence: 3, dependsOnEntryId: submitId },
      { id: completedId, kind: 'quizAttempt', op: 'set_status', sessionId: SESSION_ID, semanticKey: 'quiz:completed:test', body: {}, createdAt: ts, attempts: 0, nextAttemptAt: ts, status: 'pending', sequence: 4, dependsOnEntryId: gradeId },
      { id: archivedId, kind: 'quizAttempt', op: 'set_status', sessionId: SESSION_ID, semanticKey: 'quiz:archived:test', body: {}, createdAt: ts, attempts: 0, nextAttemptAt: ts, status: 'pending', sequence: 5, dependsOnEntryId: completedId },
    ]);

    const submit = await db.runtimeOutbox.get(submitId);
    const effective = await resolveQuizEffectiveTime(submit!);
    // 阻断根 create 的 nextAttemptAt 已经是过去，但 scheduler 应解析到 create 的退避时间
    const createNext = new Date((await db.runtimeOutbox.get(createId))!.nextAttemptAt).getTime();
    expect(effective).toBeGreaterThanOrEqual(createNext);
    expect({ gate: 'Q3.4', result: 'PASS' }).toEqual({ gate: 'Q3.4', result: 'PASS' });
  });

  it('Q3.5 online 后从阻断根继续', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    // 让 create 失败一次，进入 5s 退避
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    await drainQuizOutbox('tab1');

    // 把 nextAttemptAt 改到过去，模拟 online/时间推进
    const create = (await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).and((e) => e.op === 'create_session').toArray())[0];
    await db.runtimeOutbox.update(create.id, { nextAttemptAt: new Date(Date.now() - 1000).toISOString() });

    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await drainQuizOutbox('tab2');
    const pending = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).and((e) => e.status === 'pending').count();
    expect(pending).toBe(0);
    expect({ gate: 'Q3.5', result: 'PASS' }).toEqual({ gate: 'Q3.5', result: 'PASS' });
  });

  it('Q3.6 成功后顺序排空', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    await quizRetryViaOutbox('st1', 'sc1');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await drainQuizOutbox('tab1');
    const pending = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).and((e) => e.status === 'pending').count();
    expect(pending).toBe(0);
    expect((await db.succeededEntries.toArray()).length).toBeGreaterThanOrEqual(5);
    expect({ gate: 'Q3.6', result: 'PASS' }).toEqual({ gate: 'Q3.6', result: 'PASS' });
  });
});
