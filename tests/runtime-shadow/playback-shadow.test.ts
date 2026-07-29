import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * R2 P0 测试：playback 的 runtimeShadowEventId 必须与快照同一次本地写入持久化，
 * 影子写重试只能复用该持久化 ID。
 * savePlaybackState 用 vi.mock 截获（真实 Dexie 行为由调用方保证——本测试关注
 * 「同一次写入」的调用契约与 record id 的确定性）。
 */

const store: Record<string, string> = {};
const localStorageStub = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => {
    store[k] = String(v);
  },
  removeItem: (k: string) => {
    delete store[k];
  },
  clear: () => {
    for (const k of Object.keys(store)) delete store[k];
  },
  key: (i: number) => Object.keys(store)[i] ?? null,
  get length() {
    return Object.keys(store).length;
  },
};

let uuidCounter = 0;
vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });
vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++uuidCounter}` });

const savePlaybackStateMock = vi.hoisted(() =>
  vi.fn(
    async (
      _stageId: string,
      _snapshot: {
        sceneIndex: number;
        actionIndex: number;
        consumedDiscussions: string[];
        sceneId?: string;
        runtimeShadowEventId?: string;
      },
    ) => {},
  ),
);
vi.mock('@/lib/utils/playback-storage', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/utils/playback-storage')>();
  return { ...original, savePlaybackState: savePlaybackStateMock };
});

const fetchCalls: { url: string; method: string; body: Record<string, unknown> }[] = [];
let appendFailuresBeforeSuccess = 0;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  fetchCalls.push({ url, method: init?.method ?? 'GET', body });
  if (url === '/api/client-diagnostics') {
    return new Response('{}', { status: 200 });
  }
  if (url.includes('/records') && appendFailuresBeforeSuccess > 0) {
    appendFailuresBeforeSuccess -= 1;
    return new Response('{}', { status: 500 });
  }
  return new Response('{}', { status: 201 });
});
vi.stubGlobal('fetch', fetchMock);

import { shadowPlaybackProgress } from '@/lib/runtime/shadow-writer';

const snapshot = { sceneIndex: 2, actionIndex: 5, consumedDiscussions: ['d1'], sceneId: 'scene-9' };

describe('playback shadow write (R2 P0)', () => {
  beforeEach(() => {
    localStorageStub.clear();
    fetchCalls.length = 0;
    fetchMock.mockClear();
    savePlaybackStateMock.mockClear();
    uuidCounter = 0;
    appendFailuresBeforeSuccess = 0;
    delete process.env.NEXT_PUBLIC_RUNTIME_SHADOW;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flag off: zero local Dexie write, zero fetch', async () => {
    await shadowPlaybackProgress('stage1', snapshot);
    expect(savePlaybackStateMock).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });

  it('flag on: eventId is persisted with the snapshot in the SAME local write', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    await shadowPlaybackProgress('stage1', snapshot);
    expect(savePlaybackStateMock).toHaveBeenCalledTimes(1);
    const [stageIdArg, snapshotArg] = savePlaybackStateMock.mock.calls[0];
    expect(stageIdArg).toBe('stage1');
    expect(snapshotArg).toMatchObject({
      sceneIndex: 2,
      actionIndex: 5,
      runtimeShadowEventId: 'uuid-1',
    });
  });

  it('record id uses the persisted eventId: pb:<stageId>:<eventId>', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    await shadowPlaybackProgress('stage1', snapshot);
    const apiCalls = fetchCalls.filter((c) => c.url !== '/api/client-diagnostics');
    expect(apiCalls[0].url).toBe('/api/runtime/v1/sessions');
    expect(apiCalls[0].body).toMatchObject({
      id: 'pb:stage1',
      kind: 'playback',
      stageId: 'stage1',
    });
    const append = apiCalls.find((c) => c.url.includes('/records'));
    expect(append?.body.id).toBe('pb:stage1:uuid-1');
    expect(append?.body.payload).toEqual({
      sceneIndex: 2,
      actionIndex: 5,
      consumedDiscussions: 1,
    });
  });

  it('retry after a 5xx reuses the same eventId (anchored to the persisted write)', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    vi.useFakeTimers();
    appendFailuresBeforeSuccess = 1;
    const p = shadowPlaybackProgress('stage1', snapshot);
    await vi.runAllTimersAsync();
    await p;
    const appends = fetchCalls.filter((c) => c.url.includes('/records'));
    expect(appends).toHaveLength(2);
    expect(appends[0].body.id).toBe('pb:stage1:uuid-1');
    expect(appends[1].body.id).toBe('pb:stage1:uuid-1');
  });

  it('each new progress save generates a fresh eventId', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    await shadowPlaybackProgress('stage1', snapshot);
    await shadowPlaybackProgress('stage1', { ...snapshot, actionIndex: 6 });
    const eventIds = savePlaybackStateMock.mock.calls.map((c) => c[1].runtimeShadowEventId);
    expect(eventIds).toEqual(['uuid-1', 'uuid-2']);
  });

  it('local persist failure aborts the shadow write (no orphan server records)', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    savePlaybackStateMock.mockRejectedValueOnce(new Error('indexeddb down'));
    await shadowPlaybackProgress('stage1', snapshot);
    expect(fetchCalls.filter((c) => c.url !== '/api/client-diagnostics')).toHaveLength(0);
  });
});
