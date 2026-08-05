/**
 * R3.1 playback outbox 门禁测试
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  shadowPlaybackProgressViaOutbox, migrateShadowPendingToOutbox, drainPlaybackOutbox,
  onPlaybackOutboxStartup, isOutboxReady,
} from '@/lib/runtime/playback-outbox';
import { cleanupExpiredLeases } from '@/lib/runtime/outbox';
import { db } from '@/lib/utils/database';

const lsStore: Record<string, string> = {};
vi.stubGlobal('window', {});
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => { lsStore[k] = v; },
  removeItem: (k: string) => { delete lsStore[k]; },
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.runtimeOutbox.clear();
  await db.succeededEntries.clear();
  await db.playbackState.clear();
  await db.playbackVisits.clear();
  await db.playbackVisitStates.clear();
  for (const k of Object.keys(lsStore)) delete lsStore[k];
});

function makePlaybackRow(stageId: string, overrides: Record<string, unknown> = {}) {
  return {
    stageId, sceneIndex: 0, actionIndex: 5, consumedDiscussions: [],
    updatedAt: Date.now(), capturedAt: new Date().toISOString(),
    sceneId: 'scene-1', completed: false,
    runtimeShadowEventId: `evt-${stageId}`,
    shadowPending: { eventId: `evt-${stageId}`, capturedAt: new Date().toISOString() },
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════════

describe('开关', () => {
  it('开关关闭 → disabled', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '0');
    await db.playbackState.put(makePlaybackRow('off'));
    expect(await shadowPlaybackProgressViaOutbox('off')).toBe('disabled');
    expect(await db.runtimeOutbox.count()).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('R2.1 body 契约', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK', '1');
  });

  it('create body', async () => {
    await db.playbackState.put(makePlaybackRow('bc'));
    await shadowPlaybackProgressViaOutbox('bc');
    const create = (await db.runtimeOutbox.toArray()).find((e) => e.op === 'create_session');
    const b = create!.body as any;
    expect(b.id).toBe('pb:bc'); expect(b.kind).toBe('playback'); expect(b.stageId).toBe('bc');
  });

  it('append body', async () => {
    await db.playbackState.put(makePlaybackRow('ba', { sceneIndex: 3, actionIndex: 9 }));
    await shadowPlaybackProgressViaOutbox('ba');
    const append = (await db.runtimeOutbox.toArray()).find((e) => e.op === 'append_record');
    const b = append!.body as any;
    expect(b.payload.v).toBe(1); expect(b.payload.sceneIndex).toBe(3);
  });

  it('set_status body', async () => {
    const ts = new Date().toISOString();
    await db.playbackState.put(makePlaybackRow('bs', { completed: true, capturedAt: ts }));
    await shadowPlaybackProgressViaOutbox('bs');
    const st = (await db.runtimeOutbox.toArray()).find((e) => e.op === 'set_status');
    expect((st!.body as any).status).toBe('completed');
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('迁移 + outboxReady', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK', '1');
  });

  it('迁移成功 → outboxReady=true', async () => {
    await db.playbackState.bulkPut([makePlaybackRow('m1'), makePlaybackRow('m2')]);
    const r = await migrateShadowPendingToOutbox();
    expect(r.failed).toBe(false);
    expect(isOutboxReady()).toBe(true);
  });

  it('全已迁移（无 pending）→ outboxReady=true', async () => {
    await db.playbackState.put(makePlaybackRow('mx', { shadowPending: undefined }));
    const r = await migrateShadowPendingToOutbox();
    expect(r.failed).toBe(false);
    expect(isOutboxReady()).toBe(true);
  });

  it('迁移中第二行事务失败 → 已迁移条目 drain、未迁移保留、ready=false', async () => {
    await db.playbackState.bulkPut([
      makePlaybackRow('mf1'),
      makePlaybackRow('mf2', { completed: true }),
    ]);
    let putCount = 0;
    const realPut = (db.runtimeOutbox as any).put as Function;
    try {
      (db.runtimeOutbox as any).put = async (entry: any) => {
        putCount++;
        if (putCount >= 3) throw new Error('Injected DB write failure');
        return realPut.call(db.runtimeOutbox, entry);
      };
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
      const result = await onPlaybackOutboxStartup('tab-mf');
      expect(result.ready).toBe(false);
      expect(isOutboxReady()).toBe(false);
      // Row 1: migrated → outbox entries sent
      expect((await db.playbackState.get('mf1'))!.shadowPending).toBeUndefined();
      // Row 2: not migrated → shadowPending preserved
      const r2 = await db.playbackState.get('mf2');
      expect(r2!.shadowPending).toBeTruthy();
      // Fetch was called (row 1's entries went through)
      expect((globalThis.fetch as any).mock.calls.length).toBeGreaterThan(0);
      // No double-send: only calls for row 1 (2 ops = create + append), not row 2
      const callCount = (globalThis.fetch as any).mock.calls.length;
      expect(callCount).toBeLessThan(3); // not 3 (which would include row 2's create)
    } finally {
      (db.runtimeOutbox as any).put = realPut;
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('Recovery', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK', '1');
  });

  it('仅 outbox pending → drain 恢复', async () => {
    // Migrate first to set outboxReady
    await db.playbackState.put(makePlaybackRow('r1'));
    await migrateShadowPendingToOutbox();
    expect(isOutboxReady()).toBe(true);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await drainPlaybackOutbox('tab-r');
    expect(await db.runtimeOutbox.where('status').equals('pending').count()).toBe(0);
  });

  it('过期 lease 回收', async () => {
    await db.playbackState.put(makePlaybackRow('r2'));
    await migrateShadowPendingToOutbox();
    const entries = await db.runtimeOutbox.toArray();
    await db.runtimeOutbox.update(entries[0].id, {
      leaseOwner: 'old-tab', leaseUntil: new Date(Date.now() - 99999).toISOString(), status: 'sending',
    });
    expect(await cleanupExpiredLeases('new-tab')).toBe(1);
  });

  it('startup 全链路', async () => {
    await db.playbackState.put(makePlaybackRow('r3'));
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    const result = await onPlaybackOutboxStartup('tab-s');
    expect(result.ready).toBe(true);
    expect(isOutboxReady()).toBe(true);
    expect((await db.playbackState.get('r3'))!.shadowPending).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('Scheduler 依赖链', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK', '1');
  });

  it('create 退避 5min → 依赖链解析到 5min 而非 append 的 now', async () => {
    const nowMs = Date.now();
    const fiveMinFromNow = new Date(nowMs + 5 * 60 * 1000).toISOString();
    const createId = crypto.randomUUID();
    const appendId = crypto.randomUUID();
    await db.runtimeOutbox.bulkPut([
      {
        id: createId, kind: 'playback' as const, op: 'create_session' as const,
        sessionId: 'pb:st', semanticKey: 's:c', body: {}, createdAt: new Date().toISOString(),
        attempts: 3, nextAttemptAt: fiveMinFromNow, status: 'pending' as const, sequence: 1,
      },
      {
        id: appendId, kind: 'playback' as const, op: 'append_record' as const,
        sessionId: 'pb:st', semanticKey: 's:a', body: {}, createdAt: new Date().toISOString(),
        attempts: 0, nextAttemptAt: new Date(nowMs).toISOString(), status: 'pending' as const, sequence: 2,
        dependsOnEntryId: createId,
      },
    ]);
    const all = await db.runtimeOutbox.toArray();
    const append = all.find((e) => e.id === appendId)!;
    const { resolveEffectiveNextAttempt } = await import('@/lib/runtime/playback-outbox');
    const resolved = await resolveEffectiveNextAttempt(append);
    // Should resolve to ~5 minutes (create's blocker time), not ~now (append's own time)
    const diffMs = resolved - nowMs;
    expect(diffMs).toBeGreaterThan(4.5 * 60 * 1000); // close to 5 min
    expect(diffMs).toBeLessThan(5.5 * 60 * 1000);
  });

  it('无依赖条目用自身 nextAttemptAt', async () => {
    const nowMs = Date.now();
    const ts = new Date(nowMs + 30000).toISOString();
    const id = crypto.randomUUID();
    await db.runtimeOutbox.put({
      id, kind: 'playback' as const, op: 'create_session' as const,
      sessionId: 'pb:st2', semanticKey: 's2', body: {}, createdAt: new Date().toISOString(),
      attempts: 0, nextAttemptAt: ts, status: 'pending' as const, sequence: 1,
    });
    const { resolveEffectiveNextAttempt } = await import('@/lib/runtime/playback-outbox');
    const resolved = await resolveEffectiveNextAttempt((await db.runtimeOutbox.get(id))!);
    expect(resolved - nowMs).toBeGreaterThan(25000);
    expect(resolved - nowMs).toBeLessThan(35000);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('superseded 级联 + lease 回收', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK', '1');
  });

  it('completed 链被新快照压缩后，无 pending→superseded 悬挂', async () => {
    // Scenario: completed row creates append→status chain
    await db.playbackState.put(makePlaybackRow('csc', { completed: true }));
    await shadowPlaybackProgressViaOutbox('csc');
    // New snapshot comes in, compresses old append → superseded
    // set_status (depends on old append) should also be recursively superseded
    await db.playbackState.update('csc', {
      shadowPending: { eventId: 'evt-csc-v2', capturedAt: new Date().toISOString() },
      actionIndex: 10,
    });
    await shadowPlaybackProgressViaOutbox('csc');
    // All old entries should be superseded, new entries should be pending
    const all = await db.runtimeOutbox.toArray();
    const pending = all.filter((e) => e.status === 'pending');
    const superseded = all.filter((e) => e.status === 'superseded');
    // No pending entry should depend on a superseded entry
    const supersededIds = new Set(superseded.map((e) => e.id));
    for (const p of pending) {
      if (p.dependsOnEntryId) {
        expect(supersededIds.has(p.dependsOnEntryId)).toBe(false);
      }
    }
    // Old status entry should be superseded (not dangling pending)
    expect(superseded.some((e) => e.op === 'set_status')).toBe(true);
  });

  it('sending lease 过期 → drain 回收后后继可发送', async () => {
    // Set up: create succeeded (in succeededEntries), append is sent but sending (expired lease),
    // status depends on append
    const ts = new Date().toISOString();
    await db.succeededEntries.put({ entryId: 'create-c', deletedAt: ts });
    const appendId = 'append-lr';
    const statusId = 'status-lr';
    await db.runtimeOutbox.bulkPut([
      {
        id: appendId, kind: 'playback' as const, op: 'append_record' as const,
        sessionId: 'pb:lr', semanticKey: 'k:a', body: {}, createdAt: ts,
        attempts: 0, nextAttemptAt: ts, status: 'sending' as const, sequence: 2,
        leaseOwner: 'old-tab', leaseUntil: new Date(Date.now() - 99999).toISOString(),
      },
      {
        id: statusId, kind: 'playback' as const, op: 'set_status' as const,
        sessionId: 'pb:lr', semanticKey: 'k:s', body: { status: 'completed', updatedAt: ts },
        createdAt: ts, attempts: 0, nextAttemptAt: ts, status: 'pending' as const, sequence: 3,
        dependsOnEntryId: appendId,
      },
    ]);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    // Drain should: cleanup expired lease → send append → send status
    await drainPlaybackOutbox('tab-lr');
    const append = await db.runtimeOutbox.get(appendId);
    expect(append).toBeUndefined(); // sent
    const status = await db.runtimeOutbox.get(statusId);
    expect(status).toBeUndefined(); // sent
  });

  it('遗留 pending→superseded → dequeueOne 级联 dead', async () => {
    const ts = new Date().toISOString();
    await db.runtimeOutbox.bulkPut([
      {
        id: 'sup-ol', kind: 'playback' as const, op: 'append_record' as const,
        sessionId: 'pb:sd', semanticKey: 'k:a', body: {}, createdAt: ts,
        attempts: 0, nextAttemptAt: ts, status: 'superseded' as const, sequence: 1,
      },
      {
        id: 'pen-dep', kind: 'playback' as const, op: 'set_status' as const,
        sessionId: 'pb:sd', semanticKey: 'k:s', body: {}, createdAt: ts,
        attempts: 0, nextAttemptAt: ts, status: 'pending' as const, sequence: 2,
        dependsOnEntryId: 'sup-ol',
      },
    ]);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    const { dequeueOne } = await import('@/lib/runtime/outbox');
    await dequeueOne('tab-sd');
    const final = await db.runtimeOutbox.get('pen-dep');
    expect(final!.status).toBe('dead'); // cascaded, not stuck as pending
  });

  it('scheduler 过期 lease → resolveEffectiveNextAttempt 映射到 leaseUntil', async () => {
    const ts = new Date().toISOString();
    const nowMs = Date.now();
    const sendId = 'send-sched2';
    await db.runtimeOutbox.bulkPut([
      {
        id: sendId, kind: 'playback' as const, op: 'append_record' as const,
        sessionId: 'pb:sch2', semanticKey: 'k:a', body: {}, createdAt: ts,
        attempts: 0, nextAttemptAt: ts, status: 'sending' as const, sequence: 2,
        leaseOwner: 'old', leaseUntil: new Date(nowMs - 10000).toISOString(),
      },
      {
        id: 'stat-sched2', kind: 'playback' as const, op: 'set_status' as const,
        sessionId: 'pb:sch2', semanticKey: 'k:s', body: {},
        createdAt: ts, attempts: 0, nextAttemptAt: ts, status: 'pending' as const, sequence: 3,
        dependsOnEntryId: sendId,
      },
    ]);
    const { resolveEffectiveNextAttempt } = await import('@/lib/runtime/playback-outbox');
    const resolved = await resolveEffectiveNextAttempt((await db.runtimeOutbox.get('stat-sched2'))!);
    // Lease is 10s expired → resolved time should be in the past (≤ now + 1s)
    expect(resolved).toBeLessThanOrEqual(nowMs + 1000);
  });

  it('scheduler 5min 退避 → resolveEffectiveNextAttempt≥4.5min', async () => {
    const nowMs = Date.now();
    const fiveMin = new Date(nowMs + 5 * 60 * 1000).toISOString();
    const cId = crypto.randomUUID();
    const aId = crypto.randomUUID();
    await db.runtimeOutbox.bulkPut([
      {
        id: cId, kind: 'playback' as const, op: 'create_session' as const,
        sessionId: 'pb:nopoll', semanticKey: 's:c', body: {}, createdAt: new Date().toISOString(),
        attempts: 3, nextAttemptAt: fiveMin, status: 'pending' as const, sequence: 1,
      },
      {
        id: aId, kind: 'playback' as const, op: 'append_record' as const,
        sessionId: 'pb:nopoll', semanticKey: 's:a', body: {}, createdAt: new Date().toISOString(),
        attempts: 0, nextAttemptAt: new Date(nowMs).toISOString(), status: 'pending' as const, sequence: 2,
        dependsOnEntryId: cId,
      },
    ]);
    const { resolveEffectiveNextAttempt } = await import('@/lib/runtime/playback-outbox');
    const resolved = await resolveEffectiveNextAttempt((await db.runtimeOutbox.get(aId))!);
    // Resolve through chain to create's 5min backoff, not append's now
    expect(resolved - nowMs).toBeGreaterThan(4.5 * 60 * 1000);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('幂等+压缩', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK', '1');
  });

  it('无 shadowPending → skipped', async () => {
    await db.playbackState.put(makePlaybackRow('s1', { shadowPending: undefined }));
    expect(await shadowPlaybackProgressViaOutbox('s1')).toBe('skipped');
  });

  it('二次调用 skipped', async () => {
    await db.playbackState.put(makePlaybackRow('s2'));
    expect(await shadowPlaybackProgressViaOutbox('s2')).toBe('enqueued');
    expect(await shadowPlaybackProgressViaOutbox('s2')).toBe('skipped');
  });

  it('compaction: 旧 superseded', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await db.playbackState.put(makePlaybackRow('c1'));
    await shadowPlaybackProgressViaOutbox('c1');
    await db.playbackState.update('c1', {
      shadowPending: { eventId: 'evt-v2', capturedAt: new Date().toISOString() }, actionIndex: 10,
    });
    await shadowPlaybackProgressViaOutbox('c1');
    const entries = await db.runtimeOutbox.where('semanticKey').equals('playback:c1:latest-progress').toArray();
    expect(entries.map((e) => e.status).sort()).toEqual(['pending', 'superseded']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('依赖链', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK', '1');
  });

  it('create→append→status', async () => {
    await db.playbackState.put(makePlaybackRow('dep', { completed: true }));
    await shadowPlaybackProgressViaOutbox('dep');
    const entries = await db.runtimeOutbox.orderBy('sequence').toArray();
    expect(entries.length).toBe(3);
    expect(entries[1].dependsOnEntryId).toBe(entries[0].id);
    expect(entries[2].dependsOnEntryId).toBe(entries[1].id);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('completed 行清理', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK', '1');
  });

  it('set_status 成功后删除 completed 行', async () => {
    const evtId = 'evt-cl1';
    await db.playbackState.put(makePlaybackRow('cl1', { completed: true, runtimeShadowEventId: evtId }));
    await shadowPlaybackProgressViaOutbox('cl1');

    // Simulate: all entries succeed → drain should trigger cleanup
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await drainPlaybackOutbox('tab-c');

    // Completed row should be deleted (set_status succeeded, eventId matches)
    const row = await db.playbackState.get('cl1');
    expect(row).toBeUndefined();
  });

  it('append 成功但 status 失败 → completed 行保留', async () => {
    const evtId = 'evt-cl2';
    await db.playbackState.put(makePlaybackRow('cl2', { completed: true, runtimeShadowEventId: evtId }));
    await shadowPlaybackProgressViaOutbox('cl2');

    // Simulate: append succeeds, set_status fails → row stays
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      call++;
      // First two succeed (create + append), third fails (set_status)
      if (call <= 2) return Promise.resolve(new Response('{}', { status: 201 }));
      return Promise.reject(new Error('net'));
    });
    await drainPlaybackOutbox('tab-c');
    expect((await db.playbackState.get('cl2'))).toBeTruthy(); // still present
  });
});
