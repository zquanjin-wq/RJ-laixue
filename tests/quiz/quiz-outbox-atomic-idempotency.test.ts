/**
 * R3.2 原子幂等入队与单调链尾修复门禁（2026-08-21）
 *
 * 验证 quizSubmittedViaOutbox 在同一 Dexie rw 事务内完成幂等判定与入队，
 * 同一 attempt 无论刷新、重复调用或跨标签页并发都只拥有一套 create/submitted 链，
 * runtimeChainHeads 只前进不回退。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  quizSubmittedViaOutbox, quizReviewedViaOutbox,
  QuizSubmissionMismatchError,
} from '@/lib/runtime/quiz-outbox';
import { drainQuizOutbox } from '@/lib/runtime/quiz-outbox';
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
// QC：原子幂等与单调链尾
// ══════════════════════════════════════════════════════════════════════════════

describe('QC：原子幂等与单调链尾', () => {
  it('QC1 两标签页同时 submitted 只产生一套 create/submitted', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');

    const [r1, r2] = await Promise.all([
      quizSubmittedViaOutbox('st1', 'sc1'),
      quizSubmittedViaOutbox('st1', 'sc1'),
    ]);

    const creates = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).and((e) => e.op === 'create_session').toArray();
    const submits = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).and((e) => e.op === 'append_record').toArray();
    expect(creates).toHaveLength(1);
    expect(submits).toHaveLength(1);
    expect(submits[0].dependsOnEntryId).toBe(creates[0].id);
    const head = await db.runtimeChainHeads.get(SESSION_ID);
    expect(head?.tailEntryId).toBe(submits[0].id);
    // 两个调用返回等价幂等结果
    expect(r1).toBe('enqueued');
    expect(r2).toBe('enqueued');
  });

  it('QC2 三标签页竞争仍只有一套 create/submitted 且无间隙无垃圾', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');

    await Promise.all([
      quizSubmittedViaOutbox('st1', 'sc1'),
      quizSubmittedViaOutbox('st1', 'sc1'),
      quizSubmittedViaOutbox('st1', 'sc1'),
    ]);

    const entries = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    expect(entries.filter((e) => e.op === 'create_session')).toHaveLength(1);
    expect(entries.filter((e) => e.op === 'append_record')).toHaveLength(1);
    // sequence 无间隙
    expect(entries.map((e) => e.sequence)).toEqual([1, 2]);
    // 无 superseded 垃圾链
    expect(entries.filter((e) => e.status === 'superseded')).toHaveLength(0);
    // 无 orphan（所有 entry 归属该 session）
    for (const e of entries) expect(e.sessionId).toBe(SESSION_ID);
  });

  it('QC3 pending/sending 期间重入不生成第二套且不抢 lease', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    const before = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    const createId = before[0].id;
    const submitId = before[1].id;

    // pending 重入 → 复用
    await quizSubmittedViaOutbox('st1', 'sc1');
    const afterPending = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    expect(afterPending.map((e) => e.id)).toEqual([createId, submitId]);

    // sending 且 lease 未过期 → 复用，不抢改 lease
    const futureLease = new Date(Date.now() + 30_000).toISOString();
    await db.runtimeOutbox.update(createId, { status: 'sending', leaseOwner: 'tab-A', leaseUntil: futureLease });
    await quizSubmittedViaOutbox('st1', 'sc1');
    const createSending = await db.runtimeOutbox.get(createId);
    expect(createSending?.status).toBe('sending');
    expect(createSending?.leaseOwner).toBe('tab-A');
    expect(createSending?.leaseUntil).toBe(futureLease);
    const afterSending = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    expect(afterSending.map((e) => e.id)).toEqual([createId, submitId]);

    // sending 且 lease 已过期 → enqueue 不擅自回收 lease，回收仍由 drain 负责
    const pastLease = new Date(Date.now() - 99_999).toISOString();
    await db.runtimeOutbox.update(createId, { leaseUntil: pastLease });
    await quizSubmittedViaOutbox('st1', 'sc1');
    const createExpired = await db.runtimeOutbox.get(createId);
    expect(createExpired?.leaseUntil).toBe(pastLease);
    expect(createExpired?.status).toBe('sending');
    const afterExpired = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    expect(afterExpired.map((e) => e.id)).toEqual([createId, submitId]);
  });

  it('QC4 成功后重入零入队且成功凭据不变', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await drainQuizOutbox('tab1');

    const succBefore = await db.succeededEntries.toArray();
    const headBefore = await db.runtimeChainHeads.get(SESSION_ID);
    expect(succBefore.length).toBeGreaterThan(0);

    await quizSubmittedViaOutbox('st1', 'sc1');

    expect(await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).count()).toBe(0);
    const succAfter = await db.succeededEntries.toArray();
    expect(succAfter.map((s) => s.entryId).sort()).toEqual(succBefore.map((s) => s.entryId).sort());
    const headAfter = await db.runtimeChainHeads.get(SESSION_ID);
    expect(headAfter?.tailEntryId).toBe(headBefore?.tailEntryId);
  });

  it('QC5 后续阶段后重入不改变 outbox 且 head 保持', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    const before = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    const headBefore = await db.runtimeChainHeads.get(SESSION_ID);

    await quizSubmittedViaOutbox('st1', 'sc1');

    const after = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
    const headAfter = await db.runtimeChainHeads.get(SESSION_ID);
    expect(headAfter?.tailEntryId).toBe(headBefore?.tailEntryId);
  });

  it('QC6 payload mismatch 抛领域错误且事务零写入', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' });
    await quizSubmittedViaOutbox('st1', 'sc1');
    const outboxBefore = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).count();
    const succBefore = await db.succeededEntries.count();
    const headBefore = await db.runtimeChainHeads.get(SESSION_ID);

    // 修改持久化 envelope 的 answers（同 attemptId 不同 payload）
    store['quizAnswers:sc1'] = JSON.stringify({ v: 1, attemptId: 'att1', answers: { q1: 'B' } });

    await expect(quizSubmittedViaOutbox('st1', 'sc1')).rejects.toThrow(QuizSubmissionMismatchError);

    expect(await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).count()).toBe(outboxBefore);
    expect(await db.succeededEntries.count()).toBe(succBefore);
    const headAfter = await db.runtimeChainHeads.get(SESSION_ID);
    expect(headAfter?.tailEntryId).toBe(headBefore?.tailEntryId);
  });

  it('QC7 事务回滚时 create/submitted/head 全不提交', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' });

    // 在事务最后写入点（chain head）注入失败
    const realPut = db.runtimeChainHeads.put.bind(db.runtimeChainHeads);
    (db.runtimeChainHeads as unknown as { put: unknown }).put = async () => { throw new Error('inject fail'); };
    try {
      await expect(quizSubmittedViaOutbox('st1', 'sc1')).rejects.toThrow('inject fail');
    } finally {
      (db.runtimeChainHeads as unknown as { put: unknown }).put = realPut;
    }

    expect(await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).count()).toBe(0);
    expect(await db.runtimeChainHeads.get(SESSION_ID)).toBeUndefined();
    expect(await db.succeededEntries.count()).toBe(0);
  });

  it('QC8 刷新恢复后仍复用原 entry（只依赖 Dexie 与持久化 envelope）', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    const before = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    const createId = before[0].id;
    const submitId = before[1].id;

    // 模拟模块重载后再次 submitted（不依赖模块内存缓存）
    await quizSubmittedViaOutbox('st1', 'sc1');
    const after = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    expect(after).toHaveLength(2);
    expect(after[0].id).toBe(createId);
    expect(after[1].id).toBe(submitId);
    expect(after[1].dependsOnEntryId).toBe(createId);
  });
});
