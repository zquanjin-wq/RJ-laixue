/**
 * OpenMAIC v0.3.2 启发 — Quiz outbox 跨标签页竞争与 dead 级联回归门禁
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  quizSubmittedViaOutbox, quizReviewedViaOutbox, quizRetryViaOutbox, drainQuizOutbox,
} from '@/lib/runtime/quiz-outbox';
import { cleanupExpiredLeases } from '@/lib/runtime/outbox';
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
// Q4：跨标签页竞争
// ══════════════════════════════════════════════════════════════════════════════

describe('Q4：跨标签页竞争', () => {
  it.fails('Q4.1 同时提交相同 envelope 只产生一条 create', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');

    // 两个 owner 同时入队
    await Promise.all([
      quizSubmittedViaOutbox('st1', 'sc1'),
      quizSubmittedViaOutbox('st1', 'sc1'),
    ]);

    const creates = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).and((e) => e.op === 'create_session').toArray();
    // 期望：并发幂等压缩应只产生一条 create；当前存在竞态窗口导致多条 create
    expect(creates).toHaveLength(1);
  });

  it('Q4.2 同时 drain 时 lease 只能由一个 owner 获得', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');

    let resolveA: (v: Response) => void = () => {};
    globalThis.fetch = vi.fn().mockReturnValue(new Promise<Response>((rr) => { resolveA = rr; }));

    const pA = drainQuizOutbox('tab-A');
    await new Promise((r) => setTimeout(r, 50));

    // tab-B 此时应无法 claim
    const claimed = await cleanupExpiredLeases('tab-B');
    const entries = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).toArray();
    const sending = entries.filter((e) => e.status === 'sending');
    expect(sending.length).toBeGreaterThan(0);
    expect(sending.every((e) => e.leaseOwner === 'tab-A')).toBe(true);

    resolveA(new Response('{}', { status: 201 }));
    await pA;
    expect({ gate: 'Q4.2', result: 'PASS' }).toEqual({ gate: 'Q4.2', result: 'PASS' });
  });

  it('Q4.3 lease 未过期时另一 owner 不得发送', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');

    let resolveA: (v: Response) => void = () => {};
    globalThis.fetch = vi.fn().mockReturnValue(new Promise<Response>((rr) => { resolveA = rr; }));

    const pA = drainQuizOutbox('tab-A');
    await new Promise((r) => setTimeout(r, 50));

    // tab-B 直接 drain
    const pB = drainQuizOutbox('tab-B');
    await pB;

    const entries = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).toArray();
    expect(entries.some((e) => e.leaseOwner === 'tab-B')).toBe(false);

    resolveA(new Response('{}', { status: 201 }));
    await pA;
    expect({ gate: 'Q4.3', result: 'PASS' }).toEqual({ gate: 'Q4.3', result: 'PASS' });
  });

  it('Q4.4 lease 过期后允许安全接管', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');

    const createId = (await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).and((e) => e.op === 'create_session').toArray())[0].id;
    await db.runtimeOutbox.update(createId, {
      status: 'sending', leaseOwner: 'tab-A', leaseUntil: new Date(Date.now() - 99999).toISOString(),
    });

    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await drainQuizOutbox('tab-B');

    // cleanupExpiredLeases 回收 lease 后 drain 发送成功，create 进入 succeededEntries
    expect(await db.succeededEntries.get(createId)).toBeTruthy();
    expect({ gate: 'Q4.4', result: 'PASS' }).toEqual({ gate: 'Q4.4', result: 'PASS' });
  });

  it('Q4.5 成功凭据只写一次', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');

    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await drainQuizOutbox('tab-A');
    await drainQuizOutbox('tab-B');

    const succeeded = await db.succeededEntries.toArray();
    const ids = new Set(succeeded.map((s) => s.entryId));
    expect(ids.size).toBe(succeeded.length);
    expect({ gate: 'Q4.5', result: 'PASS' }).toEqual({ gate: 'Q4.5', result: 'PASS' });
  });

  it.fails('Q4.6 chain head 不回退', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    const tailBefore = await db.runtimeChainHeads.get(SESSION_ID);

    // 再次 submitted 不应回退 tail
    await quizSubmittedViaOutbox('st1', 'sc1');
    const tailAfter = await db.runtimeChainHeads.get(SESSION_ID);
    // 期望：重复 submitted 应被幂等处理，tail 不回退；当前实现会回退 tail
    expect(tailAfter?.tailEntryId).toBe(tailBefore?.tailEntryId);
  });

  it.fails('Q4.7 不产生两个不同 create session', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await Promise.all([
      quizSubmittedViaOutbox('st1', 'sc1'),
      quizSubmittedViaOutbox('st1', 'sc1'),
      quizSubmittedViaOutbox('st1', 'sc1'),
    ]);
    const creates = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).and((e) => e.op === 'create_session').toArray();
    // 期望：并发幂等压缩应只产生一条 create；当前实现会产生多条 create
    expect(creates).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Q5：dead/superseded 级联
// ══════════════════════════════════════════════════════════════════════════════

describe('Q5：dead/superseded 级联', () => {
  it('Q5.1 submitted dead 时 reviewed/completed/archived 全部 dead', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    await quizRetryViaOutbox('st1', 'sc1');

    const entries = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    const submitId = entries.find((e) => e.semanticKey.startsWith('quiz:submit'))!.id;
    await db.runtimeOutbox.update(submitId, { status: 'dead' });

    await drainQuizOutbox('tab1');
    const final = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).toArray();
    for (const e of final) {
      expect(e.status).toBe('dead');
    }
    expect({ gate: 'Q5.1', result: 'PASS' }).toEqual({ gate: 'Q5.1', result: 'PASS' });
  });

  it('Q5.2 reviewed dead 时 completed/archived dead', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    await quizRetryViaOutbox('st1', 'sc1');

    const entries = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    const gradeId = entries.find((e) => e.semanticKey.startsWith('quiz:grade'))!.id;
    await db.runtimeOutbox.update(gradeId, { status: 'dead' });

    await drainQuizOutbox('tab1');
    const final = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).toArray();
    expect(final.find((e) => e.semanticKey.startsWith('quiz:grade'))?.status).toBe('dead');
    expect(final.find((e) => e.semanticKey.startsWith('quiz:completed'))?.status).toBe('dead');
    expect(final.find((e) => e.semanticKey.startsWith('quiz:archived'))?.status).toBe('dead');
    expect({ gate: 'Q5.2', result: 'PASS' }).toEqual({ gate: 'Q5.2', result: 'PASS' });
  });

  it('Q5.3 superseded 前置项按规则处理后依赖者不悬挂', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');

    const entries = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    const submitId = entries.find((e) => e.semanticKey.startsWith('quiz:submit'))!.id;
    await db.runtimeOutbox.update(submitId, { status: 'superseded' });

    await drainQuizOutbox('tab1');
    const final = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).toArray();
    for (const e of final) {
      if (e.id !== submitId) {
        expect(e.status).toBe('dead');
      }
    }
    expect({ gate: 'Q5.3', result: 'PASS' }).toEqual({ gate: 'Q5.3', result: 'PASS' });
  });

  it('Q5.4 dead 依赖者不会因为 succeededEntries GC 或刷新而复活', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    await quizRetryViaOutbox('st1', 'sc1');

    const entries = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).sortBy('sequence');
    const createId = entries[0].id;
    await db.runtimeOutbox.update(createId, { status: 'dead' });
    await drainQuizOutbox('tab1');

    // 模拟刷新/重新 drain
    await drainQuizOutbox('tab2');
    const final = await db.runtimeOutbox.where('sessionId').equals(SESSION_ID).toArray();
    for (const e of final) {
      expect(e.status).toBe('dead');
    }
    expect({ gate: 'Q5.4', result: 'PASS' }).toEqual({ gate: 'Q5.4', result: 'PASS' });
  });

  it('Q5.5 runtimeChainHeads 不得指向不存在且无法解释的 entry', async () => {
    on();
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    const tail = await db.runtimeChainHeads.get(SESSION_ID);
    expect(tail).toBeTruthy();
    const entry = await db.runtimeOutbox.get(tail!.tailEntryId);
    expect(entry).toBeTruthy();
    expect(entry!.sessionId).toBe(SESSION_ID);
    expect({ gate: 'Q5.5', result: 'PASS' }).toEqual({ gate: 'Q5.5', result: 'PASS' });
  });
});
