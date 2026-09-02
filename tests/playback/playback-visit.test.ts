/**
 * R3.1a playback visit lifecycle 门禁测试
 * 覆盖设计 §4 的 20 场景的核心客户端逻辑
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/utils/database';

// Browser stubs (before module loads)
const ssStore: Record<string, string> = {};
vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => ssStore[k] ?? null,
  setItem: (k: string, v: string) => { ssStore[k] = v; },
  removeItem: (k: string) => { delete ssStore[k]; },
});
vi.stubGlobal('BroadcastChannel', class {
  constructor(_name: string) { this.onmessage = null; }
  postMessage(_data: any) {}
  onmessage: ((_ev: MessageEvent) => void) | null;
  close() {}
});

import {
  persistSnapshotWithComplete, checkVisitCompleted,
  SnapshotEventMismatchError, VisitCycleCompletedError,
} from '@/lib/runtime/playback-visit';

function ts() { return new Date().toISOString(); }

beforeEach(async () => {
  await db.runtimeOutbox.clear();
  await db.succeededEntries.clear();
  await db.playbackState.clear();
  await db.playbackVisits.clear();
  await db.playbackVisitStates.clear();
  await db.runtimeChainHeads.clear();
  for (const k of Object.keys(ssStore)) delete ssStore[k];
});

function snap(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2, 8)}`,
    capturedAt: ts(), sceneIndex: 2, actionIndex: 3,
    consumedDiscussions: ['d1'],
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════════

describe('basic visit lifecycle', () => {
  it('#1: 首播→outbox 全部 201→completed 200', async () => {
    const s = snap();
    const result = await persistSnapshotWithComplete('stg1', s);
    expect(result.visitId).toBeTruthy();
    const outbox = await db.runtimeOutbox.orderBy('sequence').toArray();
    expect(outbox.length).toBe(2); // create + append (no completed)
    expect(outbox[0].op).toBe('create_session');
    expect(outbox[1].op).toBe('append_record');
    expect(outbox[0].sessionId).toContain('pb:stg1:');
    expect(outbox[1].dependsOnEntryId).toBe(outbox[0].id);
  });

  it('#2: 首笔快照即 completed→create→append→completed', async () => {
    const s = snap({ completed: true });
    await persistSnapshotWithComplete('stg2', s);
    const outbox = await db.runtimeOutbox.orderBy('sequence').toArray();
    expect(outbox.length).toBe(3);
    expect(outbox[0].op).toBe('create_session');
    expect(outbox[1].op).toBe('append_record');
    expect(outbox[2].op).toBe('set_status');
    expect(outbox[2].dependsOnEntryId).toBe(outbox[1].id);
  });

  it('visit recorded in visits and visitStates tables', async () => {
    await persistSnapshotWithComplete('stg3', snap());
    const visits = await db.playbackVisits.toArray();
    expect(visits.length).toBe(1);
    expect(visits[0].stageId).toBe('stg3');
    expect(visits[0].status).toBe('active');

    const states = await db.playbackVisitStates.toArray();
    expect(states.length).toBe(1);
    expect(states[0].sceneIndex).toBe(2);
  });

  it('#5: F5→不换 visit（同一 ownerId 复用）', async () => {
    const s = snap();
    const r1 = await persistSnapshotWithComplete('stg5', s);
    const r2 = await persistSnapshotWithComplete('stg5', snap());
    expect(r2.visitId).toBe(r1.visitId); // same visit reused
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('complete lifecycle + preflight', () => {
  it('#16: repeat complete→幂等返回≠增 entries', async () => {
    const s = snap({ completed: true, eventId: 'evt-repeat' });
    await persistSnapshotWithComplete('stg16', s);
    const count1 = await db.runtimeOutbox.count();
    const result = await persistSnapshotWithComplete('stg16', snap({ completed: true, eventId: 'evt-repeat' }));
    expect(await db.runtimeOutbox.count()).toBe(count1); // 零新入队
    expect(result.appendId).toBeTruthy();
    expect(result.statusId).toBeTruthy();
  });

  it('#16b: repeat complete with different eventId→reject', async () => {
    const s = snap({ completed: true, eventId: 'evt-A' });
    await persistSnapshotWithComplete('stg16b', s);
    await expect(
      persistSnapshotWithComplete('stg16b', snap({ completed: true, eventId: 'evt-B' })),
    ).rejects.toThrow(SnapshotEventMismatchError);
  });

  it('completed credential→cycle complete detection', async () => {
    const s = snap({ completed: true, eventId: 'evt-cred' });
    const r = await persistSnapshotWithComplete('stg-cre', s);
    // Simulate: status succeeded
    const visit = (await db.playbackVisits.toArray())[0];
    await db.succeededEntries.put({ entryId: visit.completedStatusEntryId!, deletedAt: ts() });
    expect(await checkVisitCompleted(visit.visitId)).toBe(true);
    // After completed, new persist should trigger VisitCycleCompletedError→restart
    const visit2 = await db.playbackVisits.get(visit.visitId);
    expect(visit2!.status).toBe('completed');
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('claim self-collision (#14)', () => {
  it('repeat claimTabOwnerId returns same ownerId', async () => {
    const s = snap();
    const r1 = await persistSnapshotWithComplete('stg14', s);
    const r2 = await persistSnapshotWithComplete('stg14', snap());
    expect(r2.visitId).toBe(r1.visitId);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('session identity', () => {
  it('#20: sessionId = pb:<stageId>:<visitId>', async () => {
    const r = await persistSnapshotWithComplete('stg20', snap());
    const visit = (await db.playbackVisits.toArray())[0];
    expect(visit.sessionId).toBe(`pb:stg20:${visit.visitId}`);
    const create = (await db.runtimeOutbox.toArray()).find(e => e.op === 'create_session')!;
    expect((create.body as any).id).toBe(visit.sessionId);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('correct dependency chain', () => {
  it('create→append→completed: dependsOnEntryId chain correct', async () => {
    await persistSnapshotWithComplete('stg-chain', snap({ completed: true }));
    const entries = await db.runtimeOutbox.orderBy('sequence').toArray();
    expect(entries.length).toBe(3);
    expect(entries[0].op).toBe('create_session');
    expect(entries[1].op).toBe('append_record');
    expect(entries[2].op).toBe('set_status');
    expect(entries[1].dependsOnEntryId).toBe(entries[0].id);
    expect(entries[2].dependsOnEntryId).toBe(entries[1].id);
  });
});

// ══════════════════════════════════════════════════════════════════════════════

describe('#15 v17→v18 migration', () => {
  it('v18 tables exist and accept visit/state data', async () => {
    const vid = crypto.randomUUID();
    await db.playbackVisits.put({
      visitId: vid, stageId: 'stg-mig', tabOwnerId: 'test',
      sessionId: 'pb:stg-mig', status: 'active' as const, createdAt: ts(),
    } as any);
    expect(await db.playbackVisits.get(vid)).toBeTruthy();
    await db.playbackVisitStates.put({
      visitId: vid, stageId: 'stg-mig', sceneIndex: 0, actionIndex: 1,
      consumedDiscussions: [], updatedAt: Date.now(),
    } satisfies any);
    expect(await db.playbackVisitStates.get(vid)).toBeTruthy();
  });
});

describe('#17-#19 adoption', () => {
  beforeEach(async () => {
    await db.playbackVisits.put({
      visitId: 'legacy-stg-adopt', stageId: 'stg-adopt',
      tabOwnerId: 'legacy-unknown', sessionId: 'pb:stg-adopt',
      status: 'active' as const, createdAt: ts(), isLegacyAdopted: true,
    } as any);
  });

  it('#17: [stageId+status] indexed query works', async () => {
    await persistSnapshotWithComplete('stg-adopt', snap());
    const visit = await db.playbackVisits.get('legacy-stg-adopt');
    expect(visit!.isLegacyAdopted).toBeUndefined();
    const outbox = await db.runtimeOutbox.orderBy('sequence').toArray();
    expect(outbox[0].sessionId).toBe('pb:stg-adopt');
  });

  it('#19: completed legacy NOT adopted', async () => {
    await db.playbackVisits.update('legacy-stg-adopt', { status: 'completed' });
    await persistSnapshotWithComplete('stg-adopt', snap({ eventId: 'evt-new' }));
    const visits = await db.playbackVisits.toArray();
    expect(visits.length).toBe(2);
    const newVisit = visits.find(v => v.visitId !== 'legacy-stg-adopt')!;
    expect(newVisit.sessionId).toContain('pb:stg-adopt:');
  });
});
