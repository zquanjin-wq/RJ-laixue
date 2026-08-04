/**
 * R3.2 quiz outbox 门禁测试 — 严格链 create→submit→completed→reviewed→archived
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  quizSubmittedViaOutbox, quizReviewedViaOutbox, quizRetryViaOutbox,
  drainQuizOutbox, onQuizOutboxStartup, isQuizOutboxReady, resolveQuizEffectiveTime,
} from '@/lib/runtime/quiz-outbox';
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
function on() { vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1'); vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ', '1'); }

afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await db.runtimeOutbox.clear(); await db.succeededEntries.clear(); await db.runtimeChainHeads.clear();
  for (const k of Object.keys(store)) delete store[k];
});

// ══════════════════════════════════════════════════════════════════════════════

describe('strict chain', () => {
  beforeEach(() => on());

  it('create→submit→completed→reviewed→archived 完整严格链', async () => {
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    await quizRetryViaOutbox('st1', 'sc1');
    const entries = await db.runtimeOutbox.orderBy('sequence').toArray();
    // create(1) → submit(2) → completed(3) → reviewed(4) → archived(5)
    expect(entries.length).toBe(5);
    expect(entries[0].op).toBe('create_session');
    expect(entries[1].op).toBe('append_record'); // submit
    expect(entries[2].op).toBe('set_status');     // completed
    expect(entries[3].op).toBe('append_record'); // reviewed
    expect(entries[4].op).toBe('set_status');     // archived
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].dependsOnEntryId).toBe(entries[i - 1].id);
    }
    // completed and archived use distinct semanticKeys
    expect(entries[2].semanticKey).toContain('completed');
    expect(entries[4].semanticKey).toContain('archived');
    expect(entries[2].semanticKey).not.toBe(entries[4].semanticKey);
  });

  it('reviewed 依赖 completed（非 submit）', async () => {
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    const entries = await db.runtimeOutbox.orderBy('sequence').toArray();
    const completed = entries[2]; // set_status completed
    const reviewed = entries[3];  // append_record reviewed
    expect(reviewed.dependsOnEntryId).toBe(completed.id);
  });

  it('retry 依赖 reviewed（非无依赖）', async () => {
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    await quizRetryViaOutbox('st1', 'sc1');
    const entries = await db.runtimeOutbox.orderBy('sequence').toArray();
    expect(entries[4].dependsOnEntryId).toBe(entries[3].id); // archived depends on reviewed
  });

  it('无前序链时 retry 跳过', async () => {
    we('sc1', 'att1', { q1: 'A' });
    // No submitted/reviewed → retry has no tail → skipped
    expect(await quizRetryViaOutbox('st1', 'sc1')).toBe('skipped');
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('链尾原子性', () => {
  beforeEach(() => on());

  it('Dexie 事务成功 → 链尾更新', async () => {
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    const tailRow = await db.runtimeChainHeads.get('qa:st1:sc1:att1');
    expect(tailRow).toBeTruthy();
    const entries = await db.runtimeOutbox.orderBy('sequence').toArray();
    expect(tailRow!.tailEntryId).toBe(entries[2].id);
  });

  it('刷新恢复：只靠 Dexie 找回链尾', async () => {
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    const tailRow = await db.runtimeChainHeads.get('qa:st1:sc1:att1');
    expect(tailRow).toBeTruthy();
    const entries = await db.runtimeOutbox.orderBy('sequence').toArray();
    expect(tailRow!.tailEntryId).toBe(entries[3].id);
  });

  it('Dexie 写失败 → 链尾不前移', async () => {
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    const beforeTail = await db.runtimeChainHeads.get('qa:st1:sc1:att1');
    // Make reviewed fail
    const realPut = (db.runtimeOutbox as any).put as Function;
    try {
      (db.runtimeOutbox as any).put = async () => { throw new Error('fail'); };
      await quizReviewedViaOutbox('st1', 'sc1');
    } catch { /* expected */ }
    finally { (db.runtimeOutbox as any).put = realPut; }
    // Tail should NOT have moved
    const afterTail = await db.runtimeChainHeads.get('qa:st1:sc1:att1');
    expect(afterTail!.tailEntryId).toBe(beforeTail!.tailEntryId);
  });

  it('cleanupSucceededEntries 不清除 chain head', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await drainQuizOutbox('tab-c');
    expect(await db.succeededEntries.count()).toBeGreaterThan(0);
    const tail = await db.runtimeChainHeads.get('qa:st1:sc1:att1');
    expect(tail).toBeTruthy();
    const entries = await db.succeededEntries.toArray();
    const fake = entries.filter((e) => e.entryId.startsWith('r3quiz:tail'));
    expect(fake.length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('dead 级联全链', () => {
  beforeEach(() => on());

  it('create dead → 全链级联 dead', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    await quizRetryViaOutbox('st1', 'sc1');
    // Mark create dead
    const all = await db.runtimeOutbox.orderBy('sequence').toArray();
    await db.runtimeOutbox.update(all[0].id, { status: 'dead' });
    // drain should cascade: submit→completed→reviewed→archived all dead
    await drainQuizOutbox('tab-d');
    const final = await db.runtimeOutbox.orderBy('sequence').toArray();
    for (const e of final) expect(e.status).toBe('dead');
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('双开关 + 门禁', () => {
  it('子开关关闭 → disabled', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ', '0');
    we('sc1', 'att1', { q1: 'A' });
    expect(await quizSubmittedViaOutbox('st1', 'sc1')).toBe('disabled');
    expect(await db.runtimeOutbox.count()).toBe(0);
  });

  it('ready=1 后关闭子开关 → isQuizOutboxReady=false', async () => {
    on(); await onQuizOutboxStartup(); expect(isQuizOutboxReady()).toBe(true);
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ', '0');
    expect(isQuizOutboxReady()).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('drain + scheduler', () => {
  beforeEach(() => on());
  it('drain full chain', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    await quizRetryViaOutbox('st1', 'sc1');
    await drainQuizOutbox('tab-q');
    expect(await db.runtimeOutbox.where('status').equals('pending').count()).toBe(0);
  });

  it('3-chain resolves to root blocker time', async () => {
    const nowMs = Date.now();
    const fiveMin = new Date(nowMs + 5 * 60 * 1000).toISOString();
    const [cId, sId, tId] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await db.runtimeOutbox.bulkPut([
      { id: cId, kind: 'quizAttempt' as const, op: 'create_session' as const,
        sessionId: 'qa:cs', semanticKey: 'c', body: {}, createdAt: new Date().toISOString(),
        attempts: 3, nextAttemptAt: fiveMin, status: 'pending' as const, sequence: 1 },
      { id: sId, kind: 'quizAttempt' as const, op: 'append_record' as const,
        sessionId: 'qa:cs', semanticKey: 's', body: {}, createdAt: new Date().toISOString(),
        attempts: 0, nextAttemptAt: new Date(nowMs).toISOString(), status: 'pending' as const, sequence: 2, dependsOnEntryId: cId },
      { id: tId, kind: 'quizAttempt' as const, op: 'set_status' as const,
        sessionId: 'qa:cs', semanticKey: 't', body: {}, createdAt: new Date().toISOString(),
        attempts: 0, nextAttemptAt: new Date(nowMs).toISOString(), status: 'pending' as const, sequence: 3, dependsOnEntryId: sId },
    ]);
    const resolved = await resolveQuizEffectiveTime(
      (await db.runtimeOutbox.toArray()).find((e) => e.op === 'set_status')!,
    );
    expect(resolved - nowMs).toBeGreaterThan(4.5 * 60 * 1000);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('body 契约', () => {
  beforeEach(() => on());
  it('submit id + phase', async () => {
    we('sc1', 'att1', { q1: 'A' });
    await quizSubmittedViaOutbox('st1', 'sc1');
    const s = (await db.runtimeOutbox.toArray()).find((e) => e.semanticKey.includes('submit'))!;
    expect((s.body as any).id).toBe('qa:st1:sc1:att1:submit');
    expect((s.body as any).payload.phase).toBe('submitted');
  });
  it('completed vs archived distinct keys', async () => {
    we('sc1', 'att1', { q1: 'A' }); wr('sc1');
    await quizSubmittedViaOutbox('st1', 'sc1');
    await quizReviewedViaOutbox('st1', 'sc1');
    await quizRetryViaOutbox('st1', 'sc1');
    const statuses = (await db.runtimeOutbox.toArray()).filter((e) => e.op === 'set_status');
    expect(statuses.length).toBe(2); // completed + archived both present
  });
});
