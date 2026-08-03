/**
 * R3.0 RuntimeStore 通用 outbox 门禁测试
 *
 * 覆盖 O1-O17 验收门禁及额外确定性测试。
 * 
 * fake-indexeddb 由 tests/setup-env.ts 全局注入，本文件不重复设置。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enqueue, dequeueOne, markDead, cleanupExpiredLeases,
  cleanupDeadEntries, cleanupSucceededEntries, getLastSequence, getOutboxStats,
} from '@/lib/runtime/outbox';
import { db } from '@/lib/utils/database';

function futureMs(n: number) { return new Date(Date.now() + n).toISOString(); }
function pastMs(n: number) { return new Date(Date.now() - n).toISOString(); }
function daysAgo(d: number) { return new Date(Date.now() - d * 86400000).toISOString(); }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

afterEach(async () => {
  vi.restoreAllMocks();
  await db.runtimeOutbox.clear();
  await db.succeededEntries.clear();
});

// ══════════════════════════════════════════════════════════════════════════════
// O1：表创建
// ══════════════════════════════════════════════════════════════════════════════

describe('O1：表+字段', () => {
  it('写入读取', async () => {
    const id = await enqueue({
      kind: 'playback', op: 'append_record',
      sessionId: 'pb:o1', semanticKey: 'o1:k', body: { v: 3 },
    });
    const e = await db.runtimeOutbox.get(id);
    expect(e).toBeTruthy();
    expect(e!.body).toEqual({ v: 3 });
    await db.succeededEntries.put({ entryId: 'se', deletedAt: new Date().toISOString() });
    expect(await db.succeededEntries.get('se')).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O2：UUID + sequence
// ══════════════════════════════════════════════════════════════════════════════

describe('O2：UUID + sequence', () => {
  it('正确', async () => {
    const id = await enqueue({
      kind: 'quizAttempt', op: 'append_record', sessionId: 'qa:o2', semanticKey: 'o2:k', body: {},
    });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const sid = 'pb:seq';
    const c = await enqueue({ kind: 'playback', op: 'create_session', sessionId: sid, semanticKey: 's:c', body: {} });
    const a = await enqueue({ kind: 'playback', op: 'append_record', sessionId: sid, semanticKey: 's:a', body: {} });
    const s = await enqueue({ kind: 'playback', op: 'set_status', sessionId: sid, semanticKey: 's:s', body: {} });
    expect((await db.runtimeOutbox.get(c))!.sequence).toBe(1);
    expect((await db.runtimeOutbox.get(a))!.sequence).toBe(2);
    expect((await db.runtimeOutbox.get(s))!.sequence).toBe(3);
    expect(await getLastSequence('none')).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O3：201 成功
// ══════════════════════════════════════════════════════════════════════════════

describe('O3：201 成功', () => {
  it('同事务删+写凭据', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    const eid = await enqueue({
      kind: 'playback', op: 'append_record', sessionId: 'pb:o3', semanticKey: 'o3:k', body: {},
    });
    expect(await dequeueOne('t1')).toBe(true);
    expect(await db.runtimeOutbox.get(eid)).toBeUndefined();
    expect(await db.succeededEntries.get(eid)).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O4：lease 竞争
// ══════════════════════════════════════════════════════════════════════════════

describe('O4：lease 竞争', () => {
  it('B 被阻', async () => {
    let r: (v: Response) => void = () => {};
    globalThis.fetch = vi.fn().mockReturnValue(new Promise<Response>((rr) => { r = rr; }));
    await enqueue({ kind: 'playback', op: 'append_record', sessionId: 'pb:o4', semanticKey: 'o4:k', body: {} });
    const pA = dequeueOne('A'); await sleep(50);
    expect(await dequeueOne('B')).toBe(false);
    r(new Response('{}', { status: 201 })); await pA;
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O5：409
// ══════════════════════════════════════════════════════════════════════════════

describe('O5：409 → dead', () => {
  it('标记dead', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 409 }));
    const eid = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 'pb:o5', semanticKey: 'o5:k', body: {} });
    expect(await dequeueOne('t1')).toBe(true);
    const e = await db.runtimeOutbox.get(eid);
    expect(e!.status).toBe('dead');
    expect(e!.leaseOwner).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O6：退避
// ══════════════════════════════════════════════════════════════════════════════

describe('O6：超时退避', () => {
  it('7次 dead', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('x', 'TimeoutError'));
    const eid = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 'pb:o6', semanticKey: 'o6:k', body: {} });
    const bo = [5000, 15000, 45000, 300000, 900000, 1800000];
    for (let i = 0; i < 6; i++) {
      const b = Date.now();
      expect(await dequeueOne('t1')).toBe(true);
      const e = await db.runtimeOutbox.get(eid);
      expect(e!.status).toBe('pending');
      expect(e!.attempts).toBe(i + 1);
      expect(new Date(e!.nextAttemptAt!).getTime() - b).toBeGreaterThanOrEqual(bo[i] * 0.7);
      // Reset nextAttemptAt so next dequeue can pick it up
      await db.runtimeOutbox.update(eid, { nextAttemptAt: new Date(0).toISOString() });
    }
    expect(await dequeueOne('t1')).toBe(true);
    expect((await db.runtimeOutbox.get(eid))!.status).toBe('dead');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O7：压缩
// ══════════════════════════════════════════════════════════════════════════════

describe('O7：入队压缩', () => {
  it('3条→2sup+1pending', async () => {
    const k = 'o7:k';
    const a = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 's', semanticKey: k, body: { v: 1 } });
    const b = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 's', semanticKey: k, body: { v: 2 } });
    const c = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 's', semanticKey: k, body: { v: 3 } });
    expect((await db.runtimeOutbox.get(a))!.status).toBe('superseded');
    expect((await db.runtimeOutbox.get(b))!.status).toBe('superseded');
    expect((await db.runtimeOutbox.get(c))!.body).toEqual({ v: 3 });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O8：跨标签页
// ══════════════════════════════════════════════════════════════════════════════

describe('O8：跨标签页', () => {
  it('过期回收', async () => {
    let r: (v: Response) => void = () => {};
    globalThis.fetch = vi.fn().mockReturnValue(new Promise<Response>((rr) => { r = rr; }));
    const eid = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 'pb:o8', semanticKey: 'o8:k', body: {} });
    const pA = dequeueOne('A'); await sleep(50);
    expect(await dequeueOne('B')).toBe(false);
    await db.runtimeOutbox.update(eid, { leaseUntil: pastMs(60000) });
    expect(await cleanupExpiredLeases('B')).toBe(1);
    r(new Response('{}', { status: 201 })); await pA;
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O9：dead 清理
// ══════════════════════════════════════════════════════════════════════════════

describe('O9：dead 清理', () => {
  it('7天阈值+依赖保护', async () => {
    await db.runtimeOutbox.clear(); await db.succeededEntries.clear();
    await db.runtimeOutbox.bulkPut([
      { id: 'old', kind: 'playback' as const, op: 'append_record' as const, sessionId: 's', semanticKey: 'k1', body: {}, createdAt: daysAgo(8), attempts: 7, nextAttemptAt: daysAgo(8), status: 'dead' as const },
      { id: 'new', kind: 'playback' as const, op: 'append_record' as const, sessionId: 's', semanticKey: 'k2', body: {}, createdAt: daysAgo(3), attempts: 7, nextAttemptAt: daysAgo(3), status: 'dead' as const },
    ]);
    expect(await cleanupDeadEntries()).toBe(1);

    await db.runtimeOutbox.clear();
    await db.runtimeOutbox.bulkPut([
      { id: 'dx', kind: 'playback' as const, op: 'create_session' as const, sessionId: 's', semanticKey: 'k3', body: {}, createdAt: daysAgo(8), attempts: 7, nextAttemptAt: daysAgo(8), status: 'dead' as const },
      { id: 'd2', kind: 'playback' as const, op: 'append_record' as const, sessionId: 's', semanticKey: 'k4', body: {}, createdAt: daysAgo(1), attempts: 0, nextAttemptAt: new Date().toISOString(), status: 'pending' as const, dependsOnEntryId: 'dx' },
    ]);
    expect(await cleanupDeadEntries()).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O10：三段级联
// ══════════════════════════════════════════════════════════════════════════════

describe('O10：三段级联', () => {
  it('A→B→C 全死', async () => {
    const ts = new Date().toISOString();
    const R = (id: string, seq: number, dep?: string) => ({
      id, kind: 'playback' as const, op: (id === 'a' ? 'create_session' : id === 'c' ? 'set_status' : 'append_record') as any,
      sessionId: 's', semanticKey: id, body: {}, createdAt: ts, attempts: 0, nextAttemptAt: ts,
      status: 'pending' as const, sequence: seq, ...(dep ? { dependsOnEntryId: dep } : {}),
    });
    await db.runtimeOutbox.clear();
    await db.runtimeOutbox.bulkPut([R('a', 1), R('b', 2, 'a'), R('c', 3, 'b')]);
    expect(await markDead('a')).toBe(3);
    for (const id of ['a', 'b', 'c']) expect((await db.runtimeOutbox.get(id))!.status).toBe('dead');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O11：dependency_lost
// ══════════════════════════════════════════════════════════════════════════════

describe('O11：dependency_lost', () => {
  it('凭据孤儿 → dead', async () => {
    const ts = new Date().toISOString();
    await db.runtimeOutbox.put({
      id: 'orphan', kind: 'playback' as const, op: 'append_record' as const,
      sessionId: 's', semanticKey: 'k', body: {}, createdAt: ts, attempts: 0,
      nextAttemptAt: ts, status: 'pending' as const, dependsOnEntryId: 'ghost',
    });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    expect(await dequeueOne('t1')).toBe(true);
    expect((await db.runtimeOutbox.get('orphan'))!.status).toBe('dead');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O12：404 恢复
// ══════════════════════════════════════════════════════════════════════════════

describe('O12：404 恢复', () => {
  it('三场景', async () => {
    // scene 1: basic
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    const eid = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 'pb:o12', semanticKey: 'o12:k', body: {} });
    expect(await dequeueOne('t1')).toBe(true);
    const o = await db.runtimeOutbox.get(eid);
    expect(o!.status).toBe('pending');
    expect((await db.runtimeOutbox.get(o!.dependsOnEntryId!))!.op).toBe('create_session');

    // scene 2: create ok + retry
    await db.runtimeOutbox.clear(); await db.succeededEntries.clear();
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      call++;
      return call === 1 ? Promise.resolve(new Response('{}', { status: 404 })) : Promise.resolve(new Response('{}', { status: 201 }));
    });
    const e2 = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 'pb:o12c', semanticKey: 'o12c:k', body: {} });
    for (let i = 0; i < 3; i++) await dequeueOne('t1');
    expect(await db.runtimeOutbox.get(e2)).toBeUndefined();

    // scene 3: create dead → cascade
    await db.runtimeOutbox.clear();
    call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      call++;
      return call === 1 ? Promise.resolve(new Response('{}', { status: 404 })) : Promise.reject(new Error('net'));
    });
    const e3 = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 'pb:o12d', semanticKey: 'o12d:k', body: {} });
    await dequeueOne('t1'); // 404 → handle404
    const o3 = await db.runtimeOutbox.get(e3);
    const newCreateId = o3!.dependsOnEntryId!;
    // Retry the create 7 times, resetting backoff each time
    for (let i = 0; i < 7; i++) {
      await db.runtimeOutbox.update(newCreateId, { nextAttemptAt: new Date(0).toISOString() });
      await dequeueOne('t1');
    }
    expect((await db.runtimeOutbox.get(newCreateId))!.status).toBe('dead');
    expect((await db.runtimeOutbox.get(e3))!.status).toBe('dead');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O13：刷新恢复
// ══════════════════════════════════════════════════════════════════════════════

describe('O13：刷新恢复', () => {
  it('过期回收+有效保留', async () => {
    const R = (id: string, lo: string | null, lu: string) => ({
      id, kind: 'playback' as const, op: 'append_record' as const, sessionId: 's',
      semanticKey: id, body: {}, createdAt: pastMs(120000), attempts: 0,
      nextAttemptAt: pastMs(120000), status: 'sending' as const,
      leaseOwner: lo, leaseUntil: lu,
    });
    await db.runtimeOutbox.bulkPut([R('e', 'old', pastMs(60000)), R('v', 'alive', futureMs(120000))]);
    expect(await cleanupExpiredLeases('n')).toBe(1);
    expect((await db.runtimeOutbox.get('e'))!.status).toBe('pending');
    expect((await db.runtimeOutbox.get('v'))!.status).toBe('sending');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O14：依赖凭据
// ══════════════════════════════════════════════════════════════════════════════

describe('O14：依赖凭据', () => {
  it('凭据满足', async () => {
    await db.succeededEntries.clear();
    await db.succeededEntries.put({ entryId: 'p', deletedAt: new Date().toISOString() });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    const eid = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 's', semanticKey: 'k', body: {}, dependsOnEntryId: 'p' });
    expect(await dequeueOne('t1')).toBe(true);
    expect(await db.succeededEntries.get(eid)).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O15+16：覆盖+去重
// ══════════════════════════════════════════════════════════════════════════════

describe('O15+16：覆盖+去重', () => {
  it('3入队1发送', async () => {
    const key = 'o15:k';
    const a = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 's', semanticKey: key, body: { v: 1 } });
    const b = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 's', semanticKey: key, body: { v: 2 } });
    await enqueue({ kind: 'playback', op: 'append_record', sessionId: 's', semanticKey: key, body: { v: 3 } });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    let d = 0; for (let i = 0; i < 4; i++) { if (!await dequeueOne('t1')) break; d++; }
    expect(d).toBe(1);
    expect((await db.runtimeOutbox.get(a))!.status).toBe('superseded');
    expect((await db.runtimeOutbox.get(b))!.status).toBe('superseded');
    expect(JSON.parse((globalThis.fetch as any).mock.calls[0][1].body)).toEqual({ v: 3 });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O17：succeededEntries 延迟清理
// ══════════════════════════════════════════════════════════════════════════════

describe('O17：延迟清理', () => {
  it('有依赖者保留', async () => {
    await db.runtimeOutbox.clear(); await db.succeededEntries.clear();
    await db.succeededEntries.put({ entryId: 'p17', deletedAt: daysAgo(8) });
    await db.runtimeOutbox.put({
      id: 'd17', kind: 'playback' as const, op: 'append_record' as const,
      sessionId: 's', semanticKey: 'k', body: {}, createdAt: daysAgo(10),
      attempts: 3, nextAttemptAt: daysAgo(8), status: 'pending' as const,
      dependsOnEntryId: 'p17',
    });
    expect(await cleanupSucceededEntries()).toBe(0);

    await db.runtimeOutbox.clear(); await db.succeededEntries.clear();
    await db.succeededEntries.put({ entryId: 'orph', deletedAt: daysAgo(8) });
    expect(await cleanupSucceededEntries()).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Xtra：互斥+冻结+stats
// ══════════════════════════════════════════════════════════════════════════════

describe('Xtra', () => {
  it('互斥+冻结+stats', async () => {
    const sid = 'pb:x';
    const [x, y, z] = await Promise.all([
      enqueue({ kind: 'playback', op: 'create_session', sessionId: sid, semanticKey: 'x:1', body: {} }),
      enqueue({ kind: 'playback', op: 'append_record', sessionId: sid, semanticKey: 'x:2', body: {} }),
      enqueue({ kind: 'playback', op: 'append_record', sessionId: sid, semanticKey: 'x:3', body: {} }),
    ]);
    const seqs = [(await db.runtimeOutbox.get(x))!.sequence!, (await db.runtimeOutbox.get(y))!.sequence!, (await db.runtimeOutbox.get(z))!.sequence!];
    expect(new Set(seqs).size).toBe(3);

    const m: any = { v: 1 };
    const id = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 's', semanticKey: 'freeze', body: m });
    m.v = 999;
    expect((await db.runtimeOutbox.get(id))!.body).toEqual({ v: 1 });

    // Stats sub-test
    await db.runtimeOutbox.clear(); await db.succeededEntries.clear();
    const ts = new Date().toISOString();
    const R = (nid: string, st: string) => ({
      id: nid, kind: 'playback' as const, op: 'append_record' as const, sessionId: 's',
      semanticKey: nid, body: {}, createdAt: ts, attempts: st === 'dead' ? 7 : 0,
      nextAttemptAt: ts, status: st as any,
    });
    await db.runtimeOutbox.bulkPut([R('p', 'pending'), R('s', 'sending'), R('d', 'dead'), R('x', 'superseded')]);
    await db.succeededEntries.put({ entryId: 'done', deletedAt: ts });
    expect(await getOutboxStats()).toEqual({ pending: 1, sending: 1, dead: 1, superseded: 1, succeededEntries: 1 });
  });
});
