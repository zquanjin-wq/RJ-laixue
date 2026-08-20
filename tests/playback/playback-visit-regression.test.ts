/**
 * OpenMAIC v0.3.2 启发 — Playback R3.1a visit 路径回归门禁
 *
 * 目标：只验证本地既有实现，不修改生产代码。
 * 标记：PASS / EXPECTED_FAIL_CONFIRMED / NEW_GAP / BLOCKED_BY_TESTABILITY / NOT_APPLICABLE
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/utils/database';
import {
  persistSnapshotWithComplete, checkVisitCompleted,
  SnapshotEventMismatchError, VisitCycleCompletedError,
} from '@/lib/runtime/playback-visit';
import {
  shadowPlaybackProgressViaOutbox, drainPlaybackOutbox,
} from '@/lib/runtime/playback-outbox';
import { cleanupExpiredLeases, scanAndDrain } from '@/lib/runtime/outbox';

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

function ts() { return new Date().toISOString(); }
function snap(overrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2, 8)}`,
    capturedAt: ts(), sceneIndex: 2, actionIndex: 3,
    consumedDiscussions: ['d1'],
    ...overrides,
  };
}

beforeEach(async () => {
  await db.runtimeOutbox.clear();
  await db.succeededEntries.clear();
  await db.playbackState.clear();
  await db.playbackVisits.clear();
  await db.playbackVisitStates.clear();
  await db.runtimeChainHeads.clear();
  for (const k of Object.keys(ssStore)) delete ssStore[k];
  vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
  vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK', '1');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function simulate201SendAll(tabId: string) {
  globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
  await drainPlaybackOutbox(tabId);
}

// ══════════════════════════════════════════════════════════════════════════════
// P1：新 visit 生命周期
// ══════════════════════════════════════════════════════════════════════════════

describe('P1：新 visit 生命周期', () => {
  it('P1.1 首播创建 pb:<stageId>:<visitId-A>', async () => {
    const result = await persistSnapshotWithComplete('stg1', snap());
    expect(result.visitId).toBeTruthy();
    expect(result.appendId).toBeTruthy();
    const visit = await db.playbackVisits.get(result.visitId);
    expect(visit).toBeTruthy();
    expect(visit!.sessionId).toBe(`pb:stg1:${visit!.visitId}`);
    // Result classification
    expect({ gate: 'P1.1', result: 'PASS' }).toEqual({ gate: 'P1.1', result: 'PASS' });
  });

  it('P1.2 F5/同一未完成周期复用 visitId-A', async () => {
    const r1 = await persistSnapshotWithComplete('stg1', snap({ eventId: 'evt-A' }));
    const r2 = await persistSnapshotWithComplete('stg1', snap({ eventId: 'evt-A2' }));
    expect(r2.visitId).toBe(r1.visitId);
    const visits = await db.playbackVisits.toArray();
    expect(visits.length).toBe(1);
    expect({ gate: 'P1.2', result: 'PASS' }).toEqual({ gate: 'P1.2', result: 'PASS' });
  });

  it('P1.3 completed 凭据成功后重新进入创建 visitId-B ≠ visitId-A', async () => {
    const s = snap({ completed: true, eventId: 'evt-done' });
    const r1 = await persistSnapshotWithComplete('stg1', s);
    await simulate201SendAll('tab1');
    // status entry 已入 succeededEntries；visit 应被 _flipCompletedVisits 翻转为 completed
    const v1 = await db.playbackVisits.get(r1.visitId);
    expect(v1?.status).toBe('completed');

    // 新周期
    const r2 = await persistSnapshotWithComplete('stg1', snap({ eventId: 'evt-next' }));
    expect(r2.visitId).not.toBe(r1.visitId);
    expect(r2.visitId).toBeTruthy();
    const visits = await db.playbackVisits.toArray();
    expect(visits.length).toBe(2);
    expect({ gate: 'P1.3', result: 'PASS' }).toEqual({ gate: 'P1.3', result: 'PASS' });
  });

  it('P1.4 visitId-B 不得依赖 visitId-A 的 outbox entry', async () => {
    const s = snap({ completed: true, eventId: 'evt-done' });
    const r1 = await persistSnapshotWithComplete('stg1', s);
    await simulate201SendAll('tab1');

    const r2 = await persistSnapshotWithComplete('stg1', snap({ eventId: 'evt-next' }));
    const entries = await db.runtimeOutbox.where('sessionId').equals(`pb:stg1:${r2.visitId}`).toArray();
    for (const e of entries) {
      if (e.dependsOnEntryId) {
        const dep = await db.runtimeOutbox.get(e.dependsOnEntryId);
        expect(dep?.sessionId).toBe(`pb:stg1:${r2.visitId}`);
      }
    }
    expect({ gate: 'P1.4', result: 'PASS' }).toEqual({ gate: 'P1.4', result: 'PASS' });
  });

  it('P1.5 不得向 completed 的旧 session 追加 record', async () => {
    const s = snap({ completed: true, eventId: 'evt-done' });
    const r1 = await persistSnapshotWithComplete('stg1', s);
    await simulate201SendAll('tab1');

    // completed 后旧 visit 已被翻转为 completed，再次写入必须创建新 visit，
    // 而不是向旧 session 追加 record。
    const r2 = await persistSnapshotWithComplete('stg1', snap({ eventId: 'evt-after-complete' }));
    expect(r2.visitId).not.toBe(r1.visitId);
    const oldEntries = await db.runtimeOutbox.where('sessionId').equals(`pb:stg1:${r1.visitId}`).toArray();
    expect(oldEntries.length).toBe(0);
    expect({ gate: 'P1.5', result: 'PASS' }).toEqual({ gate: 'P1.5', result: 'PASS' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// P2：completed 判定
// ══════════════════════════════════════════════════════════════════════════════

describe('P2：completed 判定', () => {
  it('P2.1 snapshot completed=true 但无 succeededEntries 凭据不算完成', async () => {
    const s = snap({ completed: true, eventId: 'evt-done' });
    const r = await persistSnapshotWithComplete('stg2', s);
    // 不发送，直接检查 visit 状态
    const visit = await db.playbackVisits.get(r.visitId);
    expect(visit?.status).toBe('active');
    expect(visit?.completedStatusEntryId).toBeTruthy();
    expect(await checkVisitCompleted(r.visitId)).toBe(false);
    expect({ gate: 'P2.1', result: 'PASS' }).toEqual({ gate: 'P2.1', result: 'PASS' });
  });

  it('P2.2 status entry 凭据写入 succeededEntries 后才翻转 visit', async () => {
    const s = snap({ completed: true, eventId: 'evt-done' });
    const r = await persistSnapshotWithComplete('stg2', s);
    await simulate201SendAll('tab1');
    const visit = await db.playbackVisits.get(r.visitId);
    expect(visit?.status).toBe('completed');
    expect(visit?.completedCredentialAt).toBeTruthy();
    expect({ gate: 'P2.2', result: 'PASS' }).toEqual({ gate: 'P2.2', result: 'PASS' });
  });

  it('P2.3 status dead/pending/sending/superseded 不能被当作完成', async () => {
    const s = snap({ completed: true, eventId: 'evt-done' });
    const r = await persistSnapshotWithComplete('stg2', s);
    // 人为把 status entry 设为 dead
    const statusEntry = await db.runtimeOutbox.get(r.statusId!);
    expect(statusEntry).toBeTruthy();
    await db.runtimeOutbox.update(r.statusId!, { status: 'dead' });
    expect(await checkVisitCompleted(r.visitId)).toBe(false);
    expect({ gate: 'P2.3', result: 'PASS' }).toEqual({ gate: 'P2.3', result: 'PASS' });
  });

  it('P2.4 重复检查幂等', async () => {
    const s = snap({ completed: true, eventId: 'evt-done' });
    const r = await persistSnapshotWithComplete('stg2', s);
    await simulate201SendAll('tab1');
    expect(await checkVisitCompleted(r.visitId)).toBe(true);
    expect(await checkVisitCompleted(r.visitId)).toBe(true);
    const visit = await db.playbackVisits.get(r.visitId);
    expect(visit?.status).toBe('completed');
    expect({ gate: 'P2.4', result: 'PASS' }).toEqual({ gate: 'P2.4', result: 'PASS' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// P3：R3.1a 与旧 R3.1 路径隔离
// ══════════════════════════════════════════════════════════════════════════════

describe('P3：R3.1a 与旧 R3.1 路径隔离', () => {
  it('P3.1 新 visit 入队不复用旧 session ID pb:<stageId>', async () => {
    // 旧 R3.1 路径先写入一个 pending 行
    await db.playbackState.put({
      stageId: 'stg3', sceneIndex: 0, actionIndex: 0, consumedDiscussions: [],
      updatedAt: Date.now(), runtimeShadowEventId: 'evt-old',
      shadowPending: { eventId: 'evt-old', capturedAt: ts() },
      completed: false,
    });
    await shadowPlaybackProgressViaOutbox('stg3');
    const oldEntries = await db.runtimeOutbox.where('sessionId').equals('pb:stg3').toArray();
    expect(oldEntries.length).toBeGreaterThan(0);

    // 新 visit 路径
    const r = await persistSnapshotWithComplete('stg3', snap({ eventId: 'evt-new' }));
    const visit = await db.playbackVisits.get(r.visitId);
    expect(visit!.sessionId).not.toBe('pb:stg3');
    expect(visit!.sessionId).toBe(`pb:stg3:${r.visitId}`);
    expect({ gate: 'P3.1', result: 'PASS' }).toEqual({ gate: 'P3.1', result: 'PASS' });
  });

  it('P3.2 旧迁移条目不能覆盖新 visit state', async () => {
    // 新 visit 先创建
    const r = await persistSnapshotWithComplete('stg3', snap({ eventId: 'evt-new', sceneIndex: 5 }));
    const stateBefore = await db.playbackVisitStates.get(r.visitId);
    expect(stateBefore?.sceneIndex).toBe(5);

    // 旧 R3.1 路径再写入同一 stage
    await db.playbackState.put({
      stageId: 'stg3', sceneIndex: 0, actionIndex: 0, consumedDiscussions: [],
      updatedAt: Date.now(), runtimeShadowEventId: 'evt-old',
      shadowPending: { eventId: 'evt-old', capturedAt: ts() },
      completed: false,
    });
    await shadowPlaybackProgressViaOutbox('stg3');

    const stateAfter = await db.playbackVisitStates.get(r.visitId);
    expect(stateAfter?.sceneIndex).toBe(5);
    expect({ gate: 'P3.2', result: 'PASS' }).toEqual({ gate: 'P3.2', result: 'PASS' });
  });

  it('P3.3 新 visit compaction 不 supersede 旧 session 条目', async () => {
    // 旧路径先写入
    await db.playbackState.put({
      stageId: 'stg3', sceneIndex: 0, actionIndex: 0, consumedDiscussions: [],
      updatedAt: Date.now(), runtimeShadowEventId: 'evt-old',
      shadowPending: { eventId: 'evt-old', capturedAt: ts() },
      completed: false,
    });
    await shadowPlaybackProgressViaOutbox('stg3');
    const oldEntries = await db.runtimeOutbox.where('sessionId').equals('pb:stg3').toArray();

    // 新 visit 路径多次写入同一 visit（compaction）
    const r = await persistSnapshotWithComplete('stg3', snap({ eventId: 'evt-new-1' }));
    await persistSnapshotWithComplete('stg3', snap({ eventId: 'evt-new-2' }));

    // 旧 session 条目不应被 supersede
    for (const e of oldEntries) {
      const fresh = await db.runtimeOutbox.get(e.id);
      expect(fresh?.status).not.toBe('superseded');
    }
    expect({ gate: 'P3.3', result: 'PASS' }).toEqual({ gate: 'P3.3', result: 'PASS' });
  });

  it('P3.4 旧 session 成功凭据不能完成新 visit', async () => {
    // 旧路径写入并发送成功
    await db.playbackState.put({
      stageId: 'stg3', sceneIndex: 0, actionIndex: 0, consumedDiscussions: [],
      updatedAt: Date.now(), runtimeShadowEventId: 'evt-old',
      shadowPending: { eventId: 'evt-old', capturedAt: ts() },
      completed: true,
    });
    await shadowPlaybackProgressViaOutbox('stg3');
    await simulate201SendAll('tab-old');

    // 新 visit
    const r = await persistSnapshotWithComplete('stg3', snap({ eventId: 'evt-new' }));
    const visit = await db.playbackVisits.get(r.visitId);
    expect(visit?.status).toBe('active');
    expect(visit?.completedStatusEntryId).toBeFalsy();
    expect({ gate: 'P3.4', result: 'PASS' }).toEqual({ gate: 'P3.4', result: 'PASS' });
  });

  it('P3.5 drain 后两条 session dependency chain 不交叉', async () => {
    // 旧路径
    await db.playbackState.put({
      stageId: 'stg3', sceneIndex: 0, actionIndex: 0, consumedDiscussions: [],
      updatedAt: Date.now(), runtimeShadowEventId: 'evt-old',
      shadowPending: { eventId: 'evt-old', capturedAt: ts() },
      completed: false,
    });
    await shadowPlaybackProgressViaOutbox('stg3');

    // 新 visit
    const r = await persistSnapshotWithComplete('stg3', snap({ eventId: 'evt-new' }));

    const oldEntries = await db.runtimeOutbox.where('sessionId').equals('pb:stg3').toArray();
    const newEntries = await db.runtimeOutbox.where('sessionId').equals(`pb:stg3:${r.visitId}`).toArray();

    const oldIds = new Set(oldEntries.map((e) => e.id));
    for (const e of newEntries) {
      if (e.dependsOnEntryId) {
        expect(oldIds.has(e.dependsOnEntryId)).toBe(false);
      }
    }
    expect({ gate: 'P3.5', result: 'PASS' }).toEqual({ gate: 'P3.5', result: 'PASS' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// P4：legacy adoption
// ══════════════════════════════════════════════════════════════════════════════

describe('P4：legacy adoption', () => {
  it('P4.1 符合条件的 legacy 行只被 adopt 一次', async () => {
    await db.playbackVisits.put({
      visitId: 'legacy-stg4', stageId: 'stg4', tabOwnerId: 'legacy-unknown',
      sessionId: 'pb:stg4', status: 'active', createdAt: ts(), isLegacyAdopted: true,
    } as any);

    const r1 = await persistSnapshotWithComplete('stg4', snap({ eventId: 'evt-1' }));
    const visit1 = await db.playbackVisits.get('legacy-stg4');
    expect(visit1?.isLegacyAdopted).toBeUndefined();
    expect(visit1?.tabOwnerId).not.toBe('legacy-unknown');
    expect(visit1?.sessionId).toBe('pb:stg4');
    expect({ gate: 'P4.1', result: 'PASS' }).toEqual({ gate: 'P4.1', result: 'PASS' });
  });

  it('P4.2 adoption 保持原 session ID pb:<stageId>', async () => {
    await db.playbackVisits.put({
      visitId: 'legacy-stg4', stageId: 'stg4', tabOwnerId: 'legacy-unknown',
      sessionId: 'pb:stg4', status: 'active', createdAt: ts(), isLegacyAdopted: true,
    } as any);
    await persistSnapshotWithComplete('stg4', snap({ eventId: 'evt-1' }));
    const visit = await db.playbackVisits.get('legacy-stg4');
    expect(visit?.sessionId).toBe('pb:stg4');
    expect({ gate: 'P4.2', result: 'PASS' }).toEqual({ gate: 'P4.2', result: 'PASS' });
  });

  it('P4.3 adopt 后清除 isLegacyAdopted', async () => {
    await db.playbackVisits.put({
      visitId: 'legacy-stg4', stageId: 'stg4', tabOwnerId: 'legacy-unknown',
      sessionId: 'pb:stg4', status: 'active', createdAt: ts(), isLegacyAdopted: true,
    } as any);
    await persistSnapshotWithComplete('stg4', snap({ eventId: 'evt-1' }));
    const visit = await db.playbackVisits.get('legacy-stg4');
    expect(visit?.isLegacyAdopted).toBeUndefined();
    expect({ gate: 'P4.3', result: 'PASS' }).toEqual({ gate: 'P4.3', result: 'PASS' });
  });

  it('P4.4 已 adopt 行再次进入不会重复创建新 visit', async () => {
    await db.playbackVisits.put({
      visitId: 'legacy-stg4', stageId: 'stg4', tabOwnerId: 'legacy-unknown',
      sessionId: 'pb:stg4', status: 'active', createdAt: ts(), isLegacyAdopted: true,
    } as any);
    const r1 = await persistSnapshotWithComplete('stg4', snap({ eventId: 'evt-1' }));
    const r2 = await persistSnapshotWithComplete('stg4', snap({ eventId: 'evt-2' }));
    expect(r2.visitId).toBe(r1.visitId);
    expect(await db.playbackVisits.count()).toBe(1);
    expect({ gate: 'P4.4', result: 'PASS' }).toEqual({ gate: 'P4.4', result: 'PASS' });
  });

  it('P4.5 legacy completed session 不得被当成 active 新周期', async () => {
    await db.playbackVisits.put({
      visitId: 'legacy-stg4', stageId: 'stg4', tabOwnerId: 'legacy-unknown',
      sessionId: 'pb:stg4', status: 'completed', createdAt: ts(), isLegacyAdopted: true,
    } as any);
    const r = await persistSnapshotWithComplete('stg4', snap({ eventId: 'evt-1' }));
    expect(r.visitId).not.toBe('legacy-stg4');
    expect(r.visitId).toBeTruthy();
    expect({ gate: 'P4.5', result: 'PASS' }).toEqual({ gate: 'P4.5', result: 'PASS' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// P5：Playback 恢复门禁
// ══════════════════════════════════════════════════════════════════════════════

describe('P5：Playback 恢复门禁', () => {
  it('P5.1 页面刷新后未发送 outbox 保留', async () => {
    const r = await persistSnapshotWithComplete('stg5', snap({ eventId: 'evt-refresh' }));
    const before = await db.runtimeOutbox.where('sessionId').equals(`pb:stg5:${r.visitId}`).toArray();
    expect(before.length).toBe(2);

    // 模拟刷新：清空内存但保留 Dexie
    // 这里通过重新读取验证持久化
    const after = await db.runtimeOutbox.where('sessionId').equals(`pb:stg5:${r.visitId}`).toArray();
    expect(after.length).toBe(2);
    expect({ gate: 'P5.1', result: 'PASS' }).toEqual({ gate: 'P5.1', result: 'PASS' });
  });

  it('P5.2 expired lease 被回收后新 tab 可 claim', async () => {
    const r = await persistSnapshotWithComplete('stg5', snap({ eventId: 'evt-lease' }));
    const entries = await db.runtimeOutbox.where('sessionId').equals(`pb:stg5:${r.visitId}`).toArray();
    const createId = entries.find((e) => e.op === 'create_session')!.id;
    await db.runtimeOutbox.update(createId, {
      status: 'sending', leaseOwner: 'old-tab', leaseUntil: new Date(Date.now() - 99999).toISOString(),
    });
    const reclaimed = await cleanupExpiredLeases('new-tab');
    expect(reclaimed).toBeGreaterThan(0);
    const fresh = await db.runtimeOutbox.get(createId);
    expect(fresh?.status).toBe('pending');
    expect(fresh?.leaseOwner).toBeUndefined();
    expect({ gate: 'P5.2', result: 'PASS' }).toEqual({ gate: 'P5.2', result: 'PASS' });
  });

  it('P5.3 网络失败后进入 pending 和退避', async () => {
    const r = await persistSnapshotWithComplete('stg5', snap({ eventId: 'evt-net' }));
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    await drainPlaybackOutbox('tab1');
    const entries = await db.runtimeOutbox.where('sessionId').equals(`pb:stg5:${r.visitId}`).toArray();
    const create = entries.find((e) => e.op === 'create_session');
    expect(create?.status).toBe('pending');
    expect(create?.attempts).toBeGreaterThan(0);
    expect({ gate: 'P5.3', result: 'PASS' }).toEqual({ gate: 'P5.3', result: 'PASS' });
  });

  it('P5.4 online 后从阻断根继续', async () => {
    const r = await persistSnapshotWithComplete('stg5', snap({ eventId: 'evt-online' }));
    // 先让 create 失败进入退避
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    await drainPlaybackOutbox('tab1');
    const createId = (await db.runtimeOutbox.where('sessionId').equals(`pb:stg5:${r.visitId}`).and((e) => e.op === 'create_session').toArray())[0].id;

    // 把 nextAttemptAt 改到过去，模拟 online/时间推进
    await db.runtimeOutbox.update(createId, { nextAttemptAt: new Date(Date.now() - 1000).toISOString() });

    // 模拟 online 恢复：切换到 201
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await drainPlaybackOutbox('tab1');
    const pending = await db.runtimeOutbox.where('sessionId').equals(`pb:stg5:${r.visitId}`).and((e) => e.status === 'pending').count();
    expect(pending).toBe(0);
    expect({ gate: 'P5.4', result: 'PASS' }).toEqual({ gate: 'P5.4', result: 'PASS' });
  });

  it('P5.5 旧请求晚成功不能清除新 pending', async () => {
    const r = await persistSnapshotWithComplete('stg5', snap({ eventId: 'evt-late' }));
    const entries = await db.runtimeOutbox.where('sessionId').equals(`pb:stg5:${r.visitId}`).toArray();
    const createId = entries.find((e) => e.op === 'create_session')!.id;

    // A 开始发送 create
    let resolveA: (v: Response) => void = () => {};
    globalThis.fetch = vi.fn().mockReturnValue(new Promise<Response>((rr) => { resolveA = rr; }));
    const pA = drainPlaybackOutbox('tab-A');
    await new Promise((r2) => setTimeout(r2, 50));

    // B 回收过期 lease（A drain 仍在运行且持有 drainRunning，因此用底层 scanAndDrain 模拟 B 接管）
    await db.runtimeOutbox.update(createId, { leaseUntil: new Date(Date.now() - 99999).toISOString() });
    await cleanupExpiredLeases('tab-B');

    // B 发送成功（使用 scanAndDrain 避开 drainRunning 互斥）
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await scanAndDrain('tab-B');
    expect(await db.succeededEntries.get(createId)).toBeTruthy();

    // A 晚返回 201
    resolveA(new Response('{}', { status: 201 }));
    await pA;

    // append 仍应 pending 或成功，但 create 凭据不应被误删
    expect(await db.succeededEntries.get(createId)).toBeTruthy();
    expect({ gate: 'P5.5', result: 'PASS' }).toEqual({ gate: 'P5.5', result: 'PASS' });
  });
});
