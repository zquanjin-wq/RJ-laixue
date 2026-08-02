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
function installFetchStub(opts: { recordsStatus?: number } = {}) {
  const apiCalls: FetchCall[] = [];
  const diagnostics: FetchCall[] = [];
  let recordsStatus = opts.recordsStatus ?? 201;

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
      return new Response('{}', { status: 200 });
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
