/**
 * R2.1 A2 门禁测试（设计卡 v1.3 §6 门禁 6-11，Codex 授权范围 2026-08-02）。
 *
 * 覆盖：
 * 6. 刷新重试复用同一 eventId：影子 5xx 失败 → 模拟刷新（同库新会话）→
 *    挂载重试，两次 append 的 record id 相同；
 * 7. 条件清除：旧 eventId 的 clearPlaybackPending 不得清除新 pending；
 * 8. superseded：旧 pending 被新快照覆盖 → 换 UUID、上报本地丢弃指标
 *    （outcome='superseded' 进 client-diagnostics，不出现在 runtime API 调用里）；
 * 9. comparePlaybackSnapshotOrder：capturedAt 定新旧，相同按 eventId 字典序
 *    tie-break，绝不按到达顺序；
 * 10. complete 影子成功 → 行物理删除；
 * 11. 子开关门禁：NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK 未设置（即使总开关开）
 *     → 零 fetch（runtime 端点与 client-diagnostics 都为零）。
 *
 * 计时器策略同 A1：碰 Dexie 一律真实计时器。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { PlaybackPersistSnapshot } from '@/lib/utils/playback-persistence';

const STAGE = 'stage-a2-1';

const snap = (
  actionIndex: number,
  over: Partial<PlaybackPersistSnapshot> = {},
): PlaybackPersistSnapshot => ({
  sceneId: 'scene-1',
  sceneIndex: 0,
  actionIndex,
  consumedDiscussions: [],
  ...over,
});

interface FetchCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

/** fetch 桩：runtime 端点行为可按用例配置；client-diagnostics 只记录。 */
function installFetchStub(opts: { recordsStatus?: number; statusStatus?: number } = {}) {
  const apiCalls: FetchCall[] = [];
  const diagnostics: FetchCall[] = [];
  let recordsStatus = opts.recordsStatus ?? 201;
  let statusStatus = opts.statusStatus ?? 200;

  const fetchMock = vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const call: FetchCall = { url, method, body };

    if (url.includes('/api/client-diagnostics')) {
      diagnostics.push(call);
      return new Response('{"success":true}', { status: 200 });
    }
    if (url.includes('/api/runtime/v1/sessions') && url.includes('/records')) {
      apiCalls.push(call);
      return new Response('{}', { status: recordsStatus });
    }
    if (url.includes('/api/runtime/v1/sessions') && url.includes('/status')) {
      apiCalls.push(call);
      return new Response('{}', { status: statusStatus });
    }
    if (url.endsWith('/api/runtime/v1/sessions')) {
      apiCalls.push(call);
      return new Response('{}', { status: 201 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  vi.stubGlobal('fetch', fetchMock);
  return {
    apiCalls,
    diagnostics,
    setRecordsStatus(s: number) {
      recordsStatus = s;
    },
    setStatusStatus(s: number) {
      statusStatus = s;
    },
  };
}

/** 每个用例全新 fake-indexeddb + 重置模块 + window/localStorage 桩 */
async function freshModules() {
  vi.resetModules();
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal('window', { localStorage: (globalThis as { localStorage: unknown }).localStorage });
  const dbModule = await import('@/lib/utils/database');
  const persistence = await import('@/lib/utils/playback-persistence');
  const shadow = await import('@/lib/runtime/shadow-writer');
  return { db: dbModule.db, ...persistence, shadow };
}

function enableShadowSwitches() {
  process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
  process.env.NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK = '1';
}

beforeEach(() => {
  enableShadowSwitches();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_RUNTIME_SHADOW;
  delete process.env.NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
});

describe('门禁 6：刷新重试复用同一 eventId', () => {
  it('影子 5xx → 模拟刷新后挂载重试，两次 append record id 相同', async () => {
    const { db, createPlaybackPersistence, shadow } = await freshModules();
    const stub = installFetchStub({ recordsStatus: 500 });
    const ids = ['evt-1', 'evt-2'];
    let idIx = 0;
    const p = createPlaybackPersistence({
      stageId: STAGE,
      throttleMs: 20,
      uuid: () => ids[idIx++ % ids.length],
    });

    p.schedule(snap(3));
    await p.flush();
    const row = await db.playbackState.get(STAGE);
    expect(row?.runtimeShadowEventId).toBe('evt-1');
    expect(row?.shadowPending?.eventId).toBe('evt-1');

    // 第一次影子：records 恒 500 → 三次尝试（8s 超时内 1s/4s 重试）后失败
    stub.setRecordsStatus(500);
    await shadow.shadowPlaybackProgress(STAGE);
    const firstAppends = stub.apiCalls.filter((c) => c.url.includes('/records'));
    expect(firstAppends.length).toBeGreaterThan(0);
    // 失败 → pending 保留
    expect((await db.playbackState.get(STAGE))?.shadowPending?.eventId).toBe('evt-1');

    // 模拟刷新：同一 Dexie 库（新 JS 会话不清 indexedDB），挂载补写重试
    vi.resetModules();
    const shadow2 = (await import('@/lib/runtime/shadow-writer'));
    stub.setRecordsStatus(201);
    await shadow2.shadowPlaybackProgress(STAGE);

    const allAppends = stub.apiCalls.filter((c) => c.url.includes('/records'));
    const recordIds = allAppends.map((c) => (c.body as { id: string }).id);
    expect(new Set(recordIds).size).toBe(1);
    expect(recordIds[0]).toBe(`pb:${STAGE}:evt-1`);

    // 成功 → pending 条件清除
    expect((await db.playbackState.get(STAGE))?.shadowPending).toBeUndefined();
  }, 30000);
});

describe('门禁 7：条件清除', () => {
  it('旧 eventId 的清除不得误删新 pending；新 eventId 才允许清除', async () => {
    const { db, createPlaybackPersistence, clearPlaybackPending } = await freshModules();
    installFetchStub();
    const ids = ['evt-a', 'evt-b'];
    let ix = 0;
    const p = createPlaybackPersistence({
      stageId: STAGE,
      throttleMs: 20,
      uuid: () => ids[ix++ % ids.length],
    });

    p.schedule(snap(1));
    await p.flush();
    p.schedule(snap(2));
    await p.flush();

    const row = await db.playbackState.get(STAGE);
    expect(row?.shadowPending?.eventId).toBe('evt-b');

    // 旧 eventId 的晚成功 → skipped，新 pending 不动
    expect(await clearPlaybackPending(STAGE, 'evt-a')).toBe('skipped');
    expect((await db.playbackState.get(STAGE))?.shadowPending?.eventId).toBe('evt-b');

    // 当前 eventId → cleared
    expect(await clearPlaybackPending(STAGE, 'evt-b')).toBe('cleared');
    expect((await db.playbackState.get(STAGE))?.shadowPending).toBeUndefined();
    expect((await db.playbackState.get(STAGE))?.runtimeShadowEventId).toBe('evt-b');
  }, 15000);
});

describe('门禁 8：superseded 本地丢弃指标', () => {
  it('旧 pending 被新快照覆盖 → onSuperseded 触发，遥测 outcome=superseded 且不混入 runtime API', async () => {
    const { createPlaybackPersistence, shadow } = await freshModules();
    const stub = installFetchStub();
    const p = createPlaybackPersistence({
      stageId: STAGE,
      throttleMs: 20,
      onSuperseded: () => shadow.reportPlaybackSuperseded(),
    });

    p.schedule(snap(1));
    await p.flush();
    p.schedule(snap(2)); // 覆盖上一笔未发送的 pending
    await p.flush();

    const superseded = stub.diagnostics.filter(
      (c) => (c.body as { outcome?: string }).outcome === 'superseded',
    );
    expect(superseded).toHaveLength(1);
    expect((superseded[0].body as { kind?: string }).kind).toBe('playback');
    // Codex A2 复审卡（2026-08-02）：设计卡 §5 要求显式 source: local_drop，
    // 避免后续统计把本地丢弃指标当普通请求结果
    expect((superseded[0].body as { source?: string }).source).toBe('local_drop');

    // 本地丢弃指标绝不出现在 runtime API 调用里（不是服务端请求结果）
    expect(stub.apiCalls).toHaveLength(0);
  }, 15000);
});

describe('门禁 9：快照新旧比较', () => {
  it('capturedAt 定新旧；相同按 eventId 字典序 tie-break', async () => {
    const { comparePlaybackSnapshotOrder } = await freshModules();
    const older = { capturedAt: '2026-08-02T10:00:00.000Z', eventId: 'z-uuid' };
    const newer = { capturedAt: '2026-08-02T10:00:05.000Z', eventId: 'a-uuid' };
    expect(comparePlaybackSnapshotOrder(newer, older)).toBeGreaterThan(0);
    expect(comparePlaybackSnapshotOrder(older, newer)).toBeLessThan(0);

    // capturedAt 相同：eventId 字典序大者较新（与到达顺序无关）
    const x = { capturedAt: older.capturedAt, eventId: 'b-uuid' };
    const y = { capturedAt: older.capturedAt, eventId: 'a-uuid' };
    expect(comparePlaybackSnapshotOrder(x, y)).toBeGreaterThan(0);
    expect(comparePlaybackSnapshotOrder(y, x)).toBeLessThan(0);
    expect(comparePlaybackSnapshotOrder(x, x)).toBe(0);
  });
});

describe('门禁 10：complete 影子成功 → 行物理删除', () => {
  it('completed 行影子成功后从 Dexie 删除，会话置 completed', async () => {
    const { db, createPlaybackPersistence, shadow } = await freshModules();
    const stub = installFetchStub();
    const p = createPlaybackPersistence({ stageId: STAGE, throttleMs: 20, uuid: () => 'evt-c' });

    await p.complete(snap(9));
    const before = await db.playbackState.get(STAGE);
    expect(before?.completed).toBe(true);
    expect(before?.shadowPending?.eventId).toBe('evt-c');

    await shadow.shadowPlaybackProgress(STAGE);
    expect(await db.playbackState.get(STAGE)).toBeUndefined();

    // 会话状态 PATCH completed
    const statusCalls = stub.apiCalls.filter((c) => c.url.includes('/status'));
    expect(statusCalls).toHaveLength(1);
    expect((statusCalls[0].body as { status?: string }).status).toBe('completed');
  }, 15000);

  it('completed 行影子失败 → 行保留 pending，不物理删除', async () => {
    const { db, createPlaybackPersistence, shadow } = await freshModules();
    installFetchStub({ recordsStatus: 500 });
    const p = createPlaybackPersistence({ stageId: STAGE, throttleMs: 20, uuid: () => 'evt-c' });

    await p.complete(snap(9));
    await shadow.shadowPlaybackProgress(STAGE);

    const row = await db.playbackState.get(STAGE);
    expect(row?.completed).toBe(true);
    expect(row?.shadowPending?.eventId).toBe('evt-c');
  }, 30000);
});

describe('门禁 11：子开关门禁（A2 开发/部署期保持未设置）', () => {
  it('只开总开关、子开关未设置 → 影子与遥测全零 fetch', async () => {
    delete process.env.NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK;
    const { db, createPlaybackPersistence, shadow } = await freshModules();
    const stub = installFetchStub();
    const p = createPlaybackPersistence({
      stageId: STAGE,
      throttleMs: 20,
      onPersisted: () => void shadow.shadowPlaybackProgress(STAGE),
      onSuperseded: () => shadow.reportPlaybackSuperseded(),
    });

    p.schedule(snap(1));
    await p.flush();
    p.schedule(snap(2));
    await p.flush();
    await shadow.shadowPlaybackProgress(STAGE);
    shadow.reportPlaybackSuperseded();

    expect(stub.apiCalls).toHaveLength(0);
    expect(stub.diagnostics).toHaveLength(0);
    // 本地落盘不受开关影响（A1 行为不回归）
    expect((await db.playbackState.get(STAGE))?.actionIndex).toBe(2);
  }, 15000);

  it('A1 遗留行（无 eventId）首次影子时升级补写再发送', async () => {
    const { db, shadow } = await freshModules();
    const stub = installFetchStub();
    // 直接写一条 A1 形状的行：无 runtimeShadowEventId/shadowPending
    await db.playbackState.put({
      stageId: STAGE,
      sceneId: 'scene-1',
      sceneIndex: 0,
      actionIndex: 4,
      consumedDiscussions: [],
      capturedAt: '2026-08-02T09:00:00.000Z',
      completed: true,
      updatedAt: Date.now(),
    });

    await shadow.shadowPlaybackProgress(STAGE);

    const appends = stub.apiCalls.filter((c) => c.url.includes('/records'));
    expect(appends).toHaveLength(1);
    const recordId = (appends[0].body as { id: string }).id;
    expect(recordId.startsWith(`pb:${STAGE}:`)).toBe(true);
    // completed 行影子成功 → 物理删除
    expect(await db.playbackState.get(STAGE)).toBeUndefined();
  }, 15000);
});

// ── Codex A2 复审卡（2026-08-02）：三个核心失败窗口 ──────────────────────────

describe('复审卡 1：条件清除事务原子性（跨标签页竞态）', () => {
  it('旧清除事务与新快照写入竞争 → 最终新 pending 必须存在', async () => {
    const { db, createPlaybackPersistence, clearPlaybackPending } = await freshModules();
    installFetchStub();
    const ids = ['evt-old', 'evt-new'];
    let ix = 0;
    const p = createPlaybackPersistence({
      stageId: STAGE,
      throttleMs: 20,
      uuid: () => ids[ix++ % ids.length],
    });

    p.schedule(snap(1));
    await p.flush();
    expect((await db.playbackState.get(STAGE))?.shadowPending?.eventId).toBe('evt-old');

    // 受控竞态：旧 eventId 的清除与新快照落盘并发——两种交错顺序下
    // 最终行都必须是新快照且带 evt-new pending
    const clearPromise = clearPlaybackPending(STAGE, 'evt-old');
    p.schedule(snap(2));
    const flushPromise = p.flush();
    const [clearResult] = await Promise.all([clearPromise, flushPromise]);

    const row = await db.playbackState.get(STAGE);
    expect(row?.actionIndex).toBe(2);
    expect(row?.runtimeShadowEventId).toBe('evt-new');
    expect(row?.shadowPending?.eventId).toBe('evt-new');
    // 清除若发生在新快照之后必须 skipped；若在新快照之前 cleared 也可接受
    // （新快照随后覆盖写入自己的 pending）——不变量是最终状态，非中间结果
    expect(['cleared', 'skipped']).toContain(clearResult);
  }, 15000);
});

describe('复审卡 2：legacy 升级与新快照交错（事务 CAS）', () => {
  it('影子升级 legacy 行与新快照落盘并发 → 新快照不得被旧副本覆盖', async () => {
    const { db, createPlaybackPersistence, shadow } = await freshModules();
    installFetchStub();
    // A1 legacy 行：无 eventId/pending
    await db.playbackState.put({
      stageId: STAGE,
      sceneId: 'scene-1',
      sceneIndex: 0,
      actionIndex: 4,
      consumedDiscussions: [],
      capturedAt: '2026-08-02T09:00:00.000Z',
      updatedAt: Date.now(),
    });

    const p = createPlaybackPersistence({
      stageId: STAGE,
      throttleMs: 10,
      uuid: () => 'evt-new',
    });

    // 受控竞态：影子读取 legacy 行准备升级的同时，另一标签页写入新快照
    const shadowPromise = shadow.shadowPlaybackProgress(STAGE);
    p.schedule(snap(7));
    await p.flush();
    await shadowPromise;

    // 无论交错顺序如何：最终行是新快照，绝不回退到 legacy 的 actionIndex=4
    const row = await db.playbackState.get(STAGE);
    expect(row?.actionIndex).toBe(7);
    expect(row?.runtimeShadowEventId).toBe('evt-new');
  }, 15000);
});

describe('复审卡 3：completed PATCH 失败保留 pending', () => {
  it('append 成功 + status PATCH 失败 → completed 行保留；PATCH 恢复后可补偿删除', async () => {
    const { db, createPlaybackPersistence, shadow } = await freshModules();
    const stub = installFetchStub({ statusStatus: 500 });
    const p = createPlaybackPersistence({ stageId: STAGE, throttleMs: 20, uuid: () => 'evt-c' });

    await p.complete(snap(9));
    await shadow.shadowPlaybackProgress(STAGE);

    // append 已发生，但 PATCH 失败 → 行必须保留 completed pending（可补偿）
    const retained = await db.playbackState.get(STAGE);
    expect(retained?.completed).toBe(true);
    expect(retained?.shadowPending?.eventId).toBe('evt-c');
    expect(stub.apiCalls.some((c) => c.url.includes('/records'))).toBe(true);

    // PATCH 恢复：挂载补写重试 → 状态流转成功 → 行物理删除
    stub.setStatusStatus(200);
    await shadow.shadowPlaybackProgress(STAGE);
    expect(await db.playbackState.get(STAGE)).toBeUndefined();
    const statusCalls = stub.apiCalls.filter((c) => c.url.includes('/status'));
    expect(statusCalls.some((c) => (c.body as { status?: string }).status === 'completed')).toBe(
      true,
    );
  }, 30000);
});


// ── Codex A2 复审卡第二轮（2026-08-02）：幂等状态机四态分类 ──────────────────

describe('复审卡（第二轮）：幂等状态机分类', () => {
  it('状态 B：影子成功、pending 清除后再调用 → runtime API 零新增、pending 不复活', async () => {
    const { db, createPlaybackPersistence, shadow } = await freshModules();
    const stub = installFetchStub();
    const p = createPlaybackPersistence({ stageId: STAGE, throttleMs: 20, uuid: () => 'evt-ok' });

    p.schedule(snap(3));
    await p.flush();
    await shadow.shadowPlaybackProgress(STAGE);

    // 已成功：pending 清除，eventId 保留
    const cleared = await db.playbackState.get(STAGE);
    expect(cleared?.shadowPending).toBeUndefined();
    expect(cleared?.runtimeShadowEventId).toBe('evt-ok');
    const callsBefore = stub.apiCalls.length;

    // 再次调用（挂载补写/重复触发）——状态 B：幂等空转
    await shadow.shadowPlaybackProgress(STAGE);

    expect(stub.apiCalls.length).toBe(callsBefore); // runtime API 零新增
    const row = await db.playbackState.get(STAGE);
    expect(row?.shadowPending).toBeUndefined(); // pending 不复活
    expect(row?.runtimeShadowEventId).toBe('evt-ok');
  }, 15000);

  it('状态 D：eventId/pending 不一致的部分状态 → 修复为一整套全新相同 ID 再发送', async () => {
    const { db, shadow } = await freshModules();
    const stub = installFetchStub();
    // 构造异常部分状态：runtimeShadowEventId 与 shadowPending.eventId 不同
    await db.playbackState.put({
      stageId: STAGE,
      sceneId: 'scene-1',
      sceneIndex: 0,
      actionIndex: 5,
      consumedDiscussions: [],
      capturedAt: '2026-08-02T09:30:00.000Z',
      updatedAt: Date.now(),
      runtimeShadowEventId: 'old-stale-id',
      shadowPending: { eventId: 'different-pending-id', capturedAt: '2026-08-02T09:30:00.000Z' },
    });

    await shadow.shadowPlaybackProgress(STAGE);

    // 修复后发送成功、pending 已条件清除；留下的 runtimeShadowEventId
    // 必须是一整套全新 ID（禁止拼接旧新 ID）
    const row = await db.playbackState.get(STAGE);
    expect(row?.runtimeShadowEventId).toBeTruthy();
    expect(row?.runtimeShadowEventId).not.toBe('old-stale-id');
    expect(row?.runtimeShadowEventId).not.toBe('different-pending-id');

    // 发送的 record ID 使用同一个新 ID（且成功 → pending 清除）
    const appends = stub.apiCalls.filter((c) => c.url.includes('/records'));
    expect(appends).toHaveLength(1);
    expect((appends[0].body as { id: string }).id).toBe(
      `pb:${STAGE}:${row?.runtimeShadowEventId}`,
    );
    expect(row?.shadowPending).toBeUndefined();
  }, 15000);

  it('legacy 升级的 capturedAt 从事务内当前行计算，不继承事务外旧 fetched 时间', async () => {
    const { db, shadow } = await freshModules();
    installFetchStub();
    // 另一标签页刚写入的较新 legacy 快照
    await db.playbackState.put({
      stageId: STAGE,
      sceneId: 'scene-1',
      sceneIndex: 0,
      actionIndex: 8,
      consumedDiscussions: [],
      capturedAt: '2026-08-02T11:00:00.000Z',
      updatedAt: Date.now(),
    });

    // 强制事务外 fetched 读到的是旧版快照（模拟读后被并发更新）
    const staleRow = {
      stageId: STAGE,
      sceneId: 'scene-1',
      sceneIndex: 0,
      actionIndex: 2,
      consumedDiscussions: [] as string[],
      capturedAt: '2026-08-02T08:00:00.000Z',
      updatedAt: Date.now() - 3 * 3600_000,
    };
    const origGet = db.playbackState.get.bind(db.playbackState);
    let firstCall = true;
    db.playbackState.get = (async (...args: [string]) => {
      if (firstCall) {
        firstCall = false;
        return staleRow;
      }
      return origGet(...args);
    }) as typeof db.playbackState.get;

    try {
      await shadow.shadowPlaybackProgress(STAGE);
    } finally {
      db.playbackState.get = origGet;
    }

    // 事务内重读到的是较新行：升级采用新行的快照与 capturedAt，
    // 不得继承事务外旧 fetched 的 08:00 / actionIndex=2
    // （发送成功 → pending 已条件清除，capturedAt 以行字段与 append payload 为准）
    const row = await db.playbackState.get(STAGE);
    expect(row?.actionIndex).toBe(8);
    expect(row?.capturedAt).toBe('2026-08-02T11:00:00.000Z');
    expect(row?.shadowPending).toBeUndefined();
  }, 15000);
});
