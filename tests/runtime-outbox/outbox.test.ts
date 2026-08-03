/**
 * R3.0 RuntimeStore 通用 outbox 门禁测试
 * 覆盖 O1-O17 + URL分派 + lease CAS + 409递归级联
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enqueue, dequeueOne, markDead, cleanupExpiredLeases,
  cleanupDeadEntries, cleanupSucceededEntries, getLastSequence,
  getOutboxStats, buildRequest,
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
// O1：表+字段
// ══════════════════════════════════════════════════════════════════════════════

describe('O1', () => {
  it('写入读取', async () => {
    const id = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 'pb:o1', semanticKey: 'o1:k', body: { v: 3 } });
    const e = await db.runtimeOutbox.get(id);
    expect(e).toBeTruthy();
    expect(e!.body).toEqual({ v: 3 });
    await db.succeededEntries.put({ entryId: 'se', deletedAt: new Date().toISOString() });
    expect(await db.succeededEntries.get('se')).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O2
// ══════════════════════════════════════════════════════════════════════════════

describe('O2', () => {
  it('UUID + sequence', async () => {
    const id = await enqueue({ kind: 'quizAttempt', op: 'append_record', sessionId: 'qa:o2', semanticKey: 'o2:k', body: {} });
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
// P0-1：URL 分派
// ══════════════════════════════════════════════════════════════════════════════

describe('P0-1：URL分派', () => {
  it('create_session → POST /sessions', async () => {
    const e = { kind: 'playback' as const, op: 'create_session' as const, sessionId: 'pb:u', semanticKey: 'k', body: {}, createdAt: '', attempts: 0, nextAttemptAt: '', status: 'pending' as const };
    const r = buildRequest(e as any);
    expect(r.url).toBe('/api/runtime/v1/sessions');
    expect(r.method).toBe('POST');
  });
  it('append_record → POST /sessions/:id/records', async () => {
    const e = { kind: 'playback' as const, op: 'append_record' as const, sessionId: 'pb:u', semanticKey: 'k', body: {}, createdAt: '', attempts: 0, nextAttemptAt: '', status: 'pending' as const };
    const r = buildRequest(e as any);
    expect(r.url).toBe('/api/runtime/v1/sessions/pb%3Au/records');
    expect(r.method).toBe('POST');
  });
  it('set_status → PATCH /sessions/:id/status', async () => {
    const e = { kind: 'playback' as const, op: 'set_status' as const, sessionId: 'pb:u', semanticKey: 'k', body: {}, createdAt: '', attempts: 0, nextAttemptAt: '', status: 'pending' as const };
    const r = buildRequest(e as any);
    expect(r.url).toBe('/api/runtime/v1/sessions/pb%3Au/status');
    expect(r.method).toBe('PATCH');
  });
  it('dequeueOne send 使用正确URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await enqueue({ kind: 'playback', op: 'create_session', sessionId: 'pb:u1', semanticKey: 'k', body: { sessionId: 'pb:u1' } });
    await dequeueOne('t1');
    expect((globalThis.fetch as any).mock.calls[0][0]).toBe('/api/runtime/v1/sessions');

    await enqueue({ kind: 'quizAttempt', op: 'append_record', sessionId: 'qa:u2', semanticKey: 'k2', body: { answer: 'A' } });
    await dequeueOne('t1');
    const c2 = (globalThis.fetch as any).mock.calls[1];
    expect(c2[0]).toBe('/api/runtime/v1/sessions/qa%3Au2/records');
    expect(c2[1].method).toBe('POST');

    await enqueue({ kind: 'playback', op: 'set_status', sessionId: 'pb:u3', semanticKey: 'k3', body: { status: 'completed' } });
    await dequeueOne('t1');
    const c3 = (globalThis.fetch as any).mock.calls[2];
    expect(c3[0]).toBe('/api/runtime/v1/sessions/pb%3Au3/status');
    expect(c3[1].method).toBe('PATCH');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O3：201成功
// ══════════════════════════════════════════════════════════════════════════════

describe('O3', () => {
  it('201 → 删+凭据', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    const eid = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 'pb:o3', semanticKey: 'o3:k', body: {} });
    expect(await dequeueOne('t1')).toBe(true);
    expect(await db.runtimeOutbox.get(eid)).toBeUndefined();
    expect(await db.succeededEntries.get(eid)).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// P0-2：lease CAS
// ══════════════════════════════════════════════════════════════════════════════

describe('P0-2：lease CAS', () => {
  it('A lease 过期 → B claim → A 晚成功不删 B 的行', async () => {
    const eid = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 'pb:cas', semanticKey: 'o4:k', body: { v: 1 } });
    let rA: (v: Response) => void = () => {};
    globalThis.fetch = vi.fn().mockReturnValue(new Promise<Response>((rr) => { rA = rr; }));
    const pA = dequeueOne('A'); await sleep(50);
    // B 回收过期 lease
    await db.runtimeOutbox.update(eid, { leaseUntil: pastMs(60000) });
    await cleanupExpiredLeases('B');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await dequeueOne('B');
    expect(await db.succeededEntries.get(eid)).toBeTruthy();
    // A 晚返回 → 不删 B 已成功的凭据
    rA(new Response('{}', { status: 201 }));
    await pA;
    // 仍然存在（B 的凭据未被 A 覆盖删除）
    expect(await db.succeededEntries.get(eid)).toBeTruthy();
  });

  it('A lease 过期 → B claim → A 晚 404 不操作 B', async () => {
    const eid = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 'pb:cas2', semanticKey: 'o4:k', body: {} });
    let rA: (v: Response) => void = () => {};
    globalThis.fetch = vi.fn().mockReturnValue(new Promise<Response>((rr) => { rA = rr; }));
    const pA = dequeueOne('A'); await sleep(50);
    await db.runtimeOutbox.update(eid, { leaseUntil: pastMs(60000) });
    await cleanupExpiredLeases('B');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    expect(await dequeueOne('B')).toBe(true);
    // A 晚返回 404 → handle404 应跳过（leaseOwner 不匹配）
    rA(new Response('{}', { status: 404 }));
    await pA;
    // B 已成功，不应有多余 create
    expect(await db.runtimeOutbox.count()).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O4：lease 竞争
// ══════════════════════════════════════════════════════════════════════════════

describe('O4', () => {
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
// P0-3：409 递归级联
// ══════════════════════════════════════════════════════════════════════════════

describe('P0-3：409 递归级联', () => {
  it('409 触发 A→B→C 全链 dead', async () => {
    const ts = new Date().toISOString();
    const R = (id: string, seq: number, dep?: string) => ({
      id, kind: 'playback' as const, op: (id === 'a' ? 'create_session' : id === 'c' ? 'set_status' : 'append_record') as any,
      sessionId: 's', semanticKey: id, body: {}, createdAt: ts, attempts: 0, nextAttemptAt: ts,
      status: 'pending' as const, sequence: seq, ...(dep ? { dependsOnEntryId: dep } : {}),
    });
    await db.runtimeOutbox.bulkPut([R('a', 1), R('b', 2, 'a'), R('c', 3, 'b')]);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 409 }));
    // dequeueOne picks 'a', gets 409 → cascadeMarkDeadInTx('a') → b,c recursive dead
    expect(await dequeueOne('t1')).toBe(true);
    for (const id of ['a', 'b', 'c']) expect((await db.runtimeOutbox.get(id))!.status).toBe('dead');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O5：409
// ══════════════════════════════════════════════════════════════════════════════

describe('O5', () => {
  it('409 → dead', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 409 }));
    const eid = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 'pb:o5', semanticKey: 'o5:k', body: {} });
    await dequeueOne('t1');
    expect((await db.runtimeOutbox.get(eid))!.status).toBe('dead');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O6：退避
// ══════════════════════════════════════════════════════════════════════════════

describe('O6', () => {
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
      await db.runtimeOutbox.update(eid, { nextAttemptAt: new Date(0).toISOString() });
    }
    expect(await dequeueOne('t1')).toBe(true);
    expect((await db.runtimeOutbox.get(eid))!.status).toBe('dead');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O7：压缩
// ══════════════════════════════════════════════════════════════════════════════

describe('O7', () => {
  it('3→2sup+1pending', async () => {
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

describe('O8', () => {
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
// O9
// ══════════════════════════════════════════════════════════════════════════════

describe('O9', () => {
  it('7天+依赖保护', async () => {
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

describe('O10', () => {
  it('A→B→C 全死', async () => {
    const ts = new Date().toISOString();
    const R = (id: string, seq: number, dep?: string) => ({
      id, kind: 'playback' as const, op: (id === 'a' ? 'create_session' : id === 'c' ? 'set_status' : 'append_record') as any,
      sessionId: 's', semanticKey: id, body: {}, createdAt: ts, attempts: 0, nextAttemptAt: ts,
      status: 'pending' as const, sequence: seq, ...(dep ? { dependsOnEntryId: dep } : {}),
    });
    await db.runtimeOutbox.bulkPut([R('a', 1), R('b', 2, 'a'), R('c', 3, 'b')]);
    expect(await markDead('a')).toBe(3);
    for (const id of ['a', 'b', 'c']) expect((await db.runtimeOutbox.get(id))!.status).toBe('dead');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O11
// ══════════════════════════════════════════════════════════════════════════════

describe('O11', () => {
  it('dependency_lost', async () => {
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

describe('O12', () => {
  it('三场景', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    const eid = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 'pb:o12', semanticKey: 'o12:k', body: {} });
    expect(await dequeueOne('t1')).toBe(true);
    const o = await db.runtimeOutbox.get(eid);
    expect(o!.status).toBe('pending');
    expect((await db.runtimeOutbox.get(o!.dependsOnEntryId!))!.op).toBe('create_session');

    await db.runtimeOutbox.clear(); await db.succeededEntries.clear();
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      call++;
      return call === 1 ? Promise.resolve(new Response('{}', { status: 404 })) : Promise.resolve(new Response('{}', { status: 201 }));
    });
    const e2 = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 'pb:o12c', semanticKey: 'k', body: {} });
    for (let i = 0; i < 3; i++) await dequeueOne('t1');
    expect(await db.runtimeOutbox.get(e2)).toBeUndefined();

    await db.runtimeOutbox.clear();
    call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      call++;
      return call === 1 ? Promise.resolve(new Response('{}', { status: 404 })) : Promise.reject(new Error('net'));
    });
    const e3 = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 'pb:o12d', semanticKey: 'k', body: {} });
    await dequeueOne('t1');
    const o3 = await db.runtimeOutbox.get(e3);
    const ncId = o3!.dependsOnEntryId!;
    for (let i = 0; i < 7; i++) {
      await db.runtimeOutbox.update(ncId, { nextAttemptAt: new Date(0).toISOString() });
      await dequeueOne('t1');
    }
    expect((await db.runtimeOutbox.get(ncId))!.status).toBe('dead');
    expect((await db.runtimeOutbox.get(e3))!.status).toBe('dead');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// O13-O17 + Xtra
// ══════════════════════════════════════════════════════════════════════════════

describe('O13', () => {
  it('过期回收', async () => {
    const R = (id: string, lo: string | undefined, lu: string) => ({
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

describe('O14', () => {
  it('凭据满足', async () => {
    await db.succeededEntries.put({ entryId: 'p', deletedAt: new Date().toISOString() });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    const eid = await enqueue({ kind: 'playback', op: 'append_record', sessionId: 's', semanticKey: 'k', body: {}, dependsOnEntryId: 'p' });
    expect(await dequeueOne('t1')).toBe(true);
    expect(await db.succeededEntries.get(eid)).toBeTruthy();
  });
});

describe('O15+16', () => {
  it('覆盖+去重', async () => {
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

describe('O17', () => {
  it('延迟清理', async () => {
    await db.succeededEntries.put({ entryId: 'p17', deletedAt: daysAgo(8) });
    await db.runtimeOutbox.put({
      id: 'd17', kind: 'playback' as const, op: 'append_record' as const,
      sessionId: 's', semanticKey: 'k', body: {}, createdAt: daysAgo(10),
      attempts: 3, nextAttemptAt: daysAgo(8), status: 'pending' as const, dependsOnEntryId: 'p17',
    });
    expect(await cleanupSucceededEntries()).toBe(0);
    await db.runtimeOutbox.clear(); await db.succeededEntries.clear();
    await db.succeededEntries.put({ entryId: 'orph', deletedAt: daysAgo(8) });
    expect(await cleanupSucceededEntries()).toBe(1);
  });
});

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
