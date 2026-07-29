import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * R2 影子写核心测试：开关语义、请求形状、折叠游标、有界重试、失败分类与遥测分母。
 * fetch 全 mock；runtime API 与 /api/client-diagnostics 由同一 mock 承接，按 URL 区分。
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

import type { ChatSession } from '@/lib/types/chat';
import {
  RUNTIME_SHADOW_VERSION,
  isRuntimeShadowEnabled,
  shadowChatSessions,
  shadowQuizRetry,
  shadowQuizReviewed,
  shadowQuizSubmitted,
} from '@/lib/runtime/shadow-writer';
import { writeSubmittedAnswers } from '@/lib/quiz/persistence';

// ─── fetch mock 基建 ──────────────────────────────────────────────────────────

type FetchCall = { url: string; method: string; body: Record<string, unknown> };

const fetchCalls: FetchCall[] = [];
let responder: (url: string, body: Record<string, unknown>) => { status: number };

function jsonResponse(status: number, payload: unknown = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  fetchCalls.push({ url, method: init?.method ?? 'GET', body });
  if (url === '/api/client-diagnostics') return jsonResponse(200, { success: true });
  const { status } = responder(url, body);
  return jsonResponse(status);
});
vi.stubGlobal('fetch', fetchMock);

/** 默认全部 2xx；测试按需覆写 responder。 */
function okResponder(): { status: number } {
  return { status: 201 };
}

const apiCalls = () => fetchCalls.filter((c) => c.url !== '/api/client-diagnostics');
const telemetryCalls = () =>
  fetchCalls.filter((c) => c.url === '/api/client-diagnostics').map((c) => c.body);
const telemetryOutcomes = () => telemetryCalls().map((b) => b.outcome);

function makeChatSession(id: string, messageIds: string[], status = 'interrupted'): ChatSession {
  return {
    id,
    type: 'qa',
    title: 't',
    status: status as ChatSession['status'],
    messages: messageIds.map((mid, i) => ({
      id: mid,
      role: i % 2 === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', text: `text of ${mid}` }],
      metadata: { createdAt: 1_700_000_000_000 + i * 1000 },
    })) as ChatSession['messages'],
    config: {} as ChatSession['config'],
    toolCalls: [],
    pendingToolCalls: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    sceneId: 'scene-1',
  };
}

describe('runtime shadow writer', () => {
  beforeEach(() => {
    localStorageStub.clear();
    fetchCalls.length = 0;
    fetchMock.mockClear();
    uuidCounter = 0;
    responder = okResponder;
    delete process.env.NEXT_PUBLIC_RUNTIME_SHADOW;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── 开关 ──────────────────────────────────────────────────────────────

  it('flag off (unset): zero fetch, zero local writes for all three kinds', async () => {
    expect(isRuntimeShadowEnabled()).toBe(false);
    await shadowChatSessions('stage1', [makeChatSession('cs1', ['m1'])]);
    await shadowQuizSubmitted('stage1', 'scene1', { q1: 'a' });
    await shadowQuizReviewed('stage1', 'scene1', []);
    await shadowQuizRetry('stage1', 'scene1');
    expect(fetchCalls).toHaveLength(0);
    // 连 attemptId 都不该因影子路径产生（只有 writeSubmittedAnswers 会写）
    expect(readStoreKeys()).toHaveLength(0);
  });

  it("flag off ('0'): still fully inert", async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '0';
    await shadowChatSessions('stage1', [makeChatSession('cs1', ['m1'])]);
    expect(fetchCalls).toHaveLength(0);
  });

  it('flag on without stageId: quiz shadow skips silently', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    writeSubmittedAnswers('scene1', { q1: 'a' });
    await shadowQuizSubmitted(null, 'scene1', { q1: 'a' });
    expect(apiCalls()).toHaveLength(0);
  });

  function readStoreKeys(): string[] {
    return Object.keys(store);
  }

  // ─── quizAttempt ───────────────────────────────────────────────────────

  it('submit: creates session with deterministic id, appends submit record, sets completed', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    writeSubmittedAnswers('scene1', { q1: 'a' });
    await shadowQuizSubmitted('stage1', 'scene1', { q1: 'a' });

    const calls = apiCalls();
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'PATCH']);
    const sessionId = 'qa:stage1:scene1:uuid-1';
    expect(calls[0].url).toBe('/api/runtime/v1/sessions');
    expect(calls[0].body).toMatchObject({
      id: sessionId,
      kind: 'quizAttempt',
      stageId: 'stage1',
      status: 'active',
    });
    expect(calls[1].url).toBe(`/api/runtime/v1/sessions/${encodeURIComponent(sessionId)}/records`);
    expect(calls[1].body).toMatchObject({
      id: `${sessionId}:submit`,
      sceneId: 'scene1',
      payload: { phase: 'submitted', answers: { q1: 'a' } },
    });
    expect(calls[2].url).toBe(`/api/runtime/v1/sessions/${encodeURIComponent(sessionId)}/status`);
    expect(calls[2].body).toMatchObject({ status: 'completed' });
    expect(telemetryOutcomes()).toEqual(['ok', 'ok', 'ok']);
    expect(telemetryCalls()[0]).toMatchObject({
      event: 'runtime_shadow',
      shadowVersion: RUNTIME_SHADOW_VERSION,
      op: 'create_session',
      kind: 'quizAttempt',
    });
  });

  it('resubmit after refresh reuses the same session id (attemptId persisted)', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    writeSubmittedAnswers('scene1', { q1: 'a' });
    await shadowQuizSubmitted('stage1', 'scene1', { q1: 'a' });
    // 模拟刷新后重试影子写：attemptId 从 localStorage 读回 → 同一会话 id；
    // create 撞 409 → ok_idempotent，append 幂等重放同内容
    responder = (url) => ({ status: url === '/api/runtime/v1/sessions' ? 409 : 201 });
    fetchCalls.length = 0;
    await shadowQuizSubmitted('stage1', 'scene1', { q1: 'a' });
    // created marker 已在上一轮写入 → 本轮不发 create，直接 append + PATCH
    expect(apiCalls().map((c) => c.method)).toEqual(['POST', 'PATCH']);
    expect(apiCalls()[0].body.id).toBe('qa:stage1:scene1:uuid-1:submit');
    expect(apiCalls()[0].url).toContain(encodeURIComponent('qa:stage1:scene1:uuid-1'));
    expect(telemetryOutcomes()).toEqual(['ok', 'ok']);
  });

  it('409 on first create counts as ok_idempotent and proceeds to append', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    writeSubmittedAnswers('scene1', { q1: 'a' });
    responder = (url) => ({ status: url === '/api/runtime/v1/sessions' ? 409 : 201 });
    await shadowQuizSubmitted('stage1', 'scene1', { q1: 'a' });
    expect(apiCalls()).toHaveLength(3);
    expect(telemetryOutcomes()).toEqual(['ok_idempotent', 'ok', 'ok']);
  });

  it('reviewed: appends grade record with reviewed phase (DSL enum, not local wording)', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    writeSubmittedAnswers('scene1', { q1: 'a' });
    await shadowQuizReviewed('stage1', 'scene1', [
      { questionId: 'q1', earned: 1, total: 1 } as never,
    ]);
    const append = apiCalls().find((c) => c.url.includes('/records'));
    expect(append?.body.id).toBe('qa:stage1:scene1:uuid-1:grade');
    expect((append?.body.payload as Record<string, unknown>).phase).toBe('reviewed');
    expect((append?.body.payload as Record<string, unknown>).answers).toEqual({ q1: 'a' });
  });

  it('retry: archives the attempt session, only when it was shadow-created', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    // 未影子化过的周期：归档跳过
    writeSubmittedAnswers('scene1', { q1: 'a' });
    await shadowQuizRetry('stage1', 'scene1');
    expect(apiCalls()).toHaveLength(0);

    // 影子化过的周期：PATCH archived
    await shadowQuizSubmitted('stage1', 'scene1', { q1: 'a' });
    fetchCalls.length = 0;
    await shadowQuizRetry('stage1', 'scene1');
    const calls = apiCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].body).toMatchObject({ status: 'archived' });
  });

  // ─── chat 折叠 ─────────────────────────────────────────────────────────

  it('chat fold: first save creates + appends all; second save appends only the delta', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    await shadowChatSessions('stage1', [makeChatSession('cs1', ['m1', 'm2'])]);
    expect(apiCalls().map((c) => `${c.method}:${c.url.includes('/records') ? 'append' : c.url.includes('/status') ? 'status' : 'create'}`)).toEqual([
      'POST:create',
      'POST:append',
      'POST:append',
    ]);

    fetchCalls.length = 0;
    await shadowChatSessions('stage1', [makeChatSession('cs1', ['m1', 'm2', 'm3'])]);
    const calls = apiCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.id).toBe('cs1:m3');
    expect((calls[0].body.payload as Record<string, unknown>).content).toBe('text of m3');
  });

  it('chat payload is {role, content} with text assembled from UIMessage parts', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    await shadowChatSessions('stage1', [makeChatSession('cs1', ['m1', 'm2'])]);
    const appends = apiCalls().filter((c) => c.url.includes('/records'));
    expect(appends[0].body.payload).toEqual({ role: 'user', content: 'text of m1' });
    expect(appends[1].body.payload).toEqual({ role: 'assistant', content: 'text of m2' });
    // record createdAt 来自 metadata.createdAt（确定性，重放不漂移）
    expect(appends[0].body.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('chat interrupted status maps to active; completed follows with one PATCH', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    await shadowChatSessions('stage1', [makeChatSession('cs1', ['m1'], 'interrupted')]);
    expect(apiCalls()[0].body.status).toBe('active');

    fetchCalls.length = 0;
    await shadowChatSessions('stage1', [makeChatSession('cs1', ['m1'], 'completed')]);
    const patch = apiCalls().find((c) => c.method === 'PATCH');
    expect(patch?.body).toMatchObject({ status: 'completed' });

    // 折叠：再次保存不重复 PATCH
    fetchCalls.length = 0;
    await shadowChatSessions('stage1', [makeChatSession('cs1', ['m1'], 'completed')]);
    expect(apiCalls().filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('chat truncation resets the cursor and idempotently replays (record ids stable)', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    const many = Array.from({ length: 200 }, (_, i) => `m${i}`);
    await shadowChatSessions('stage1', [makeChatSession('cs1', many)]);
    expect(apiCalls().filter((c) => c.url.includes('/records'))).toHaveLength(200);

    // 截断后数组变短（起点前移）：游标 200 > 150 → 归零重放，id 稳定故服务端幂等
    fetchCalls.length = 0;
    const truncated = Array.from({ length: 150 }, (_, i) => `m${i + 50}`);
    await shadowChatSessions('stage1', [makeChatSession('cs1', truncated)]);
    expect(apiCalls().filter((c) => c.url.includes('/records'))).toHaveLength(150);
  });

  it('empty sessions (delete path) does nothing', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    await shadowChatSessions('stage1', []);
    expect(fetchCalls).toHaveLength(0);
  });

  // ─── 重试与失败分类 ────────────────────────────────────────────────────

  it('5xx is retried at most twice (3 attempts total), terminal telemetry http_5xx', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    vi.useFakeTimers();
    responder = () => ({ status: 500 });
    writeSubmittedAnswers('scene1', { q1: 'a' });
    const p = shadowQuizSubmitted('stage1', 'scene1', { q1: 'a' });
    await vi.runAllTimersAsync();
    await p;
    expect(apiCalls()).toHaveLength(3);
    expect(telemetryOutcomes()).toEqual(['http_5xx']);
    // create 失败 → 不再 append
    expect(apiCalls().every((c) => c.url === '/api/runtime/v1/sessions')).toBe(true);
  });

  it('network error is retried then counted once; 4xx validation is not retried', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    vi.useFakeTimers();
    // 网络错误：fetch 直接 reject（once 实现绕过了基础实现的记录，需手动记账）
    fetchMock.mockImplementationOnce((input, init) => {
      fetchCalls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      });
      return Promise.reject(new TypeError('fetch failed'));
    });
    responder = () => ({ status: 400 });
    writeSubmittedAnswers('scene1', { q1: 'a' });
    const p = shadowQuizSubmitted('stage1', 'scene1', { q1: 'a' });
    await vi.runAllTimersAsync();
    await p;
    // 第 1 次 network（reject）→ 1s 后第 2 次得到 400 → 不重试
    expect(apiCalls()).toHaveLength(2);
    expect(telemetryOutcomes()).toEqual(['validation']);
  });

  it('timeout aborts at 8s and is retried; auth (401/403) is not retried', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    vi.useFakeTimers();
    // 永不 resolve、只对 abort 响应的 fetch → 走 timeout 分支（once 实现需手动记账）
    fetchMock.mockImplementationOnce(
      (input, init) =>
        new Promise<Response>((_resolve, reject) => {
          fetchCalls.push({
            url: String(input),
            method: init?.method ?? 'GET',
            body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
          });
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        }),
    );
    responder = () => ({ status: 401 });
    writeSubmittedAnswers('scene1', { q1: 'a' });
    const p = shadowQuizSubmitted('stage1', 'scene1', { q1: 'a' });
    await vi.runAllTimersAsync();
    await p;
    // timeout → 重试 1 次 → 401 终态不重试
    expect(apiCalls()).toHaveLength(2);
    expect(telemetryOutcomes()).toEqual(['auth']);
  });

  it('append 409 counts as idempotency_conflict and is not retried', async () => {
    process.env.NEXT_PUBLIC_RUNTIME_SHADOW = '1';
    responder = (url) => ({ status: url.includes('/records') ? 409 : 201 });
    await shadowChatSessions('stage1', [makeChatSession('cs1', ['m1'])]);
    expect(telemetryOutcomes()).toEqual(['ok', 'idempotency_conflict']);
    // 冲突后游标不前进，下次保存从同一下标重试
    fetchCalls.length = 0;
    responder = okResponder;
    await shadowChatSessions('stage1', [makeChatSession('cs1', ['m1', 'm2'])]);
    const appends = apiCalls().filter((c) => c.url.includes('/records'));
    expect(appends.map((c) => c.body.id)).toEqual(['cs1:m1', 'cs1:m2']);
  });
});
