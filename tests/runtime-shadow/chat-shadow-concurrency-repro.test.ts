/**
 * OpenMAIC v0.3.2 启发 — Chat shadow 并发窗口 reproduction
 *
 * 目标：只复现/记录问题，不修改生产代码。
 * 允许 EXPECTED_FAIL_CONFIRMED / NEW_GAP / BLOCKED_BY_TESTABILITY。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession } from '@/lib/types/chat';
import { shadowChatSessions } from '@/lib/runtime/shadow-writer';

const store: Record<string, string> = {};

const localStorageStub = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => { store[k] = String(v); },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  key: (i: number) => Object.keys(store)[i] ?? null,
  get length() { return Object.keys(store).length; },
};

vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

beforeEach(() => {
  localStorageStub.clear();
  fetchCalls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type FetchCall = { url: string; method: string; body: Record<string, unknown> };
const fetchCalls: FetchCall[] = [];

function jsonResponse(status: number, payload: unknown = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setupFetchMock(responder?: (url: string, body: Record<string, unknown>) => { status: number; responseBody?: Record<string, unknown> }) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    fetchCalls.push({ url, method: init?.method ?? 'GET', body });
    if (url === '/api/client-diagnostics') return jsonResponse(200);
    if (responder) {
      const { status, responseBody } = responder(url, body);
      return jsonResponse(status, responseBody);
    }
    return jsonResponse(201);
  });
}

function makeChatSession(
  id: string,
  messageIds: string[],
  contentForId: (mid: string) => string,
  status: ChatSession['status'] = 'interrupted',
): ChatSession {
  return {
    id,
    type: 'qa',
    title: 't',
    status,
    messages: messageIds.map((mid, i) => ({
      id: mid,
      role: i % 2 === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', text: contentForId(mid) }],
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

function apiCalls() {
  return fetchCalls.filter((c) => c.url !== '/api/client-diagnostics');
}

// ══════════════════════════════════════════════════════════════════════════════
// C1：旧游标并发读取
// ══════════════════════════════════════════════════════════════════════════════

describe('C1：旧游标并发读取', () => {
  // C1.1：JS 单线程事件循环下难以稳定让第二次调用在第一次写 cursor 前读到旧游标，
  // 无法在不改生产代码增加 seam 的情况下受控复现。移出可执行测试统计，作为 testability 缺口记录。
  it.skip('C1.1 两次并发 shadowChatSessions 读到同一旧 cursor 并发送不同 payload', async () => {
    expect(true).toBe(true);
  });

  it('C1.2 相同 session + message.id 生成相同 record ID', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    const sessionId = 'cs-same-id';
    const s1 = makeChatSession(sessionId, ['m1'], () => 'hello');

    setupFetchMock();
    await shadowChatSessions('stage1', [s1]);

    const records = apiCalls().filter((c) => c.url.includes('/records'));
    const ids = records.map((c) => c.body.id as string);
    expect(ids.every((id) => id === `${sessionId}:m1`)).toBe(true);
    expect({ gate: 'C1.2', result: 'PASS' }).toEqual({ gate: 'C1.2', result: 'PASS' });
  });

  it('C1.3 遇到 409 IDEMPOTENCY_CONFLICT 时 cursor 仍前进', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    const sessionId = 'cs-conflict';
    const s1 = makeChatSession(sessionId, ['m1'], () => 'hello');

    setupFetchMock(() => ({ status: 409, responseBody: { errorCode: 'IDEMPOTENCY_CONFLICT', error: 'mismatch' } }));

    await shadowChatSessions('stage1', [s1]);
    const cursorRaw = store[`rshadow:chat:${sessionId}`];
    const cursor = JSON.parse(cursorRaw);
    expect(cursor.count).toBe(1);
    expect({ gate: 'C1.3', result: 'PASS' }).toEqual({ gate: 'C1.3', result: 'PASS' });
  });

  it('C1.4 cursor 最终指向前进位置', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    const sessionId = 'cs-cursor-final';
    const s1 = makeChatSession(sessionId, ['m1', 'm2'], (mid) => `text-${mid}`);

    setupFetchMock();
    await shadowChatSessions('stage1', [s1]);
    const cursorRaw = store[`rshadow:chat:${sessionId}`];
    const cursor = JSON.parse(cursorRaw);
    expect(cursor.count).toBe(2);
    expect({ gate: 'C1.4', result: 'PASS' }).toEqual({ gate: 'C1.4', result: 'PASS' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// C2：合法重复与 payload 漂移
// ══════════════════════════════════════════════════════════════════════════════

describe('C2：合法重复与 payload 漂移', () => {
  it('C2.1 相同 record ID + 相同 payload 应视为合法幂等重复', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    const sessionId = 'cs-idempotent';
    const s1 = makeChatSession(sessionId, ['m1'], () => 'canonical');

    setupFetchMock();
    await shadowChatSessions('stage1', [s1]);

    // 模拟旧游标被重读：重置 cursor 以强制再次发送同一条 message
    store[`rshadow:chat:${sessionId}`] = JSON.stringify({ count: 0 });
    await shadowChatSessions('stage1', [s1]);

    const records = apiCalls().filter((c) => c.url.includes('/records'));
    // 确实产生两次 /records 请求
    expect(records).toHaveLength(2);

    const ids = records.map((c) => c.body.id as string);
    expect(new Set(ids).size).toBe(1); // record ID 相同

    const payloads = records.map((c) => JSON.stringify(c.body.payload));
    expect(new Set(payloads).size).toBe(1); // canonical payload 相同

    // 两次均按 201 处理（mock 返回 201），cursor 最终前进到 1
    const cursorRaw = store[`rshadow:chat:${sessionId}`];
    const cursor = JSON.parse(cursorRaw);
    expect(cursor.count).toBe(1);
  });

  it.fails('C2.2 相同 record ID + 不同 payload 应识别为 payload 漂移', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    const sessionId = 'cs-drift';

    // 第一次调用成功，cursor 前进到 1
    await shadowChatSessions('stage1', [makeChatSession(sessionId, ['m1'], () => 'hello')]);
    // 模拟旧游标被回退（并发/刷新损坏场景），再次调用且 content 已变
    store[`rshadow:chat:${sessionId}`] = JSON.stringify({ count: 0 });

    // 服务端对 payload 漂移返回 409 IDEMPOTENCY_CONFLICT
    setupFetchMock(() => ({ status: 409, responseBody: { errorCode: 'IDEMPOTENCY_CONFLICT' } }));
    await shadowChatSessions('stage1', [makeChatSession(sessionId, ['m1'], () => 'world')]);

    const records = apiCalls().filter((c) => c.url.includes('/records'));
    const driftRecord = records.find((c) => (c.body.payload as Record<string, string>)?.content === 'world');
    expect(driftRecord).toBeTruthy(); // 第二次请求确实被发出

    // 期望：系统识别到 drift 后不应再前进 cursor；当前实现会把 409 当作幂等成功并前进 cursor
    const cursor = JSON.parse(store[`rshadow:chat:${sessionId}`]);
    expect(cursor.count).toBe(0);
  });

  it.fails('C2.3 当前实现不能将 payload 漂移与普通重试区分', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    const sessionId = 'cs-drift-misclassified';

    let call = 0;
    setupFetchMock(() => {
      call++;
      return call === 1 ? { status: 201 } : { status: 409, responseBody: { errorCode: 'IDEMPOTENCY_CONFLICT' } };
    });

    await shadowChatSessions('stage1', [makeChatSession(sessionId, ['m1'], () => 'hello')]);
    // 回退游标模拟并发/损坏
    store[`rshadow:chat:${sessionId}`] = JSON.stringify({ count: 0 });
    await shadowChatSessions('stage1', [makeChatSession(sessionId, ['m1'], () => 'world')]);

    const cursorRaw = store[`rshadow:chat:${sessionId}`];
    const cursor = JSON.parse(cursorRaw);
    // 期望：不同 payload 的 409 IDEMPOTENCY_CONFLICT 应被识别为 drift，cursor 不应前进；
    // 当前实现会把它当作普通重试并前进游标。
    expect(cursor.count).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// C3：多 session 隔离
// ══════════════════════════════════════════════════════════════════════════════

describe('C3：多 session 隔离', () => {
  it('C3.1 Session A 的游标推进不影响 Session B', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    const sA = makeChatSession('cs-A', ['m1'], () => 'A');
    const sB = makeChatSession('cs-B', ['m1'], () => 'B');

    setupFetchMock();
    await shadowChatSessions('stage1', [sA, sB]);

    const cursorA = JSON.parse(store['rshadow:chat:cs-A']);
    const cursorB = JSON.parse(store['rshadow:chat:cs-B']);
    expect(cursorA.count).toBe(1);
    expect(cursorB.count).toBe(1);
    expect({ gate: 'C3.1', result: 'PASS' }).toEqual({ gate: 'C3.1', result: 'PASS' });
  });

  it('C3.2 Session A 的失败不阻断 Session B', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    const sA = makeChatSession('cs-A', ['m1'], () => 'A');
    const sB = makeChatSession('cs-B', ['m1'], () => 'B');

    let call = 0;
    setupFetchMock((url) => {
      call++;
      if (url.includes('/sessions') && call <= 1) {
        return { status: 500 };
      }
      return { status: 201 };
    });

    await shadowChatSessions('stage1', [sA, sB]);

    const cursorB = store['rshadow:chat:cs-B'];
    expect(cursorB).toBeTruthy();
    expect(JSON.parse(cursorB).count).toBe(1);
    expect({ gate: 'C3.2', result: 'PASS' }).toEqual({ gate: 'C3.2', result: 'PASS' });
  });

  it('C3.3 不同 session 之间不得复用 record ID', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    const sA = makeChatSession('cs-A', ['m1'], () => 'A');
    const sB = makeChatSession('cs-B', ['m1'], () => 'B');

    setupFetchMock();
    await shadowChatSessions('stage1', [sA, sB]);

    const records = apiCalls().filter((c) => c.url.includes('/records'));
    const ids = records.map((c) => c.body.id as string);
    expect(ids).toContain('cs-A:m1');
    expect(ids).toContain('cs-B:m1');
    expect(ids.filter((id) => id === 'cs-A:m1').length).toBe(1);
    expect(ids.filter((id) => id === 'cs-B:m1').length).toBe(1);
    expect({ gate: 'C3.3', result: 'PASS' }).toEqual({ gate: 'C3.3', result: 'PASS' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// C4：finalized 缺口证据
// ══════════════════════════════════════════════════════════════════════════════

describe('C4：finalized 缺口证据', () => {
  it.fails('C4.1 当前实现无法可靠判断 assistant message 是否 finalized', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    const sessionId = 'cs-finalized';
    const s1 = makeChatSession(sessionId, ['u1', 'a1'], (mid) => `text-${mid}`);

    setupFetchMock();
    await shadowChatSessions('stage1', [s1]);

    const records = apiCalls().filter((c) => c.url.includes('/records'));
    // 期望：assistant message record 应携带 finalized 信号，以区分流式中间态与终态；
    // 当前实现不会写入 finalized 字段。
    const assistantRecords = records.filter((c) => {
      const payload = c.body.payload as Record<string, unknown>;
      return payload && payload.role === 'assistant';
    });
    expect(assistantRecords.length).toBeGreaterThan(0);
    for (const r of assistantRecords) {
      expect((r.body.payload as Record<string, unknown>)?.finalized).toBe(true);
    }
  });

  it.fails('C4.2 仅通过再次保存或 content 变化不能形成不可变记录', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    const sessionId = 'cs-mutable';

    setupFetchMock();
    await shadowChatSessions('stage1', [makeChatSession(sessionId, ['m1'], () => 'v1')]);
    // 正常再次保存，content 已变化；cursor 已前进，系统不会发送新 record
    await shadowChatSessions('stage1', [makeChatSession(sessionId, ['m1'], () => 'v2')]);

    const records = apiCalls().filter((c) => c.url.includes('/records'));
    const v2Records = records.filter((c) => (c.body.payload as Record<string, string>)?.content === 'v2');
    // 期望：content 变化应形成新不可变记录或明确报错；当前实现会静默忽略变化
    expect(v2Records.length).toBeGreaterThan(0);
  });

  it.fails('C4.3 单纯增加 finalized 字段仍不足以关闭旧游标并发窗口', async () => {
    // 设计断言：即使 message 有 finalized 字段，只要 shadowChatSessions 是 fire-and-forget
    // 且 cursor 不是原子读取-推进，并发调用仍可能在 finalized 写入前读到旧 cursor。
    // 通过构造 create_session 挂起的并发场景说明该窗口。
    vi.stubEnv('NEXT_PUBLIC_RUNTIME_SHADOW', '1');
    const sessionId = 'cs-finalized-not-enough';
    const s1 = makeChatSession(sessionId, ['m1'], () => 'hello');

    let resolveFirst: (v: Response) => void = () => {};
    let resolveSecond: (v: Response) => void = () => {};
    let sessionCount = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      fetchCalls.push({ url, method: init?.method ?? 'GET', body });
      if (url === '/api/client-diagnostics') return jsonResponse(200);
      if (url === '/api/runtime/v1/sessions') {
        sessionCount++;
        if (sessionCount === 1) return new Promise<Response>((resolve) => { resolveFirst = resolve; });
        return new Promise<Response>((resolve) => { resolveSecond = resolve; });
      }
      return jsonResponse(201);
    });

    const p1 = shadowChatSessions('stage1', [s1]);
    await new Promise((r) => setTimeout(r, 50));

    const p2 = shadowChatSessions('stage1', [makeChatSession(sessionId, ['m1'], () => 'finalized')]);
    await new Promise((r) => setTimeout(r, 50));

    resolveFirst(jsonResponse(201));
    resolveSecond(jsonResponse(201));
    await p1;
    await p2;

    const records = apiCalls().filter((c) => c.url.includes('/records'));
    // 期望：要关闭旧游标窗口，需要 per-session 串行化或原子 cursor/outbox，
    // 因此并发下对同一条 message 应只产生一条 records 请求；当前实现会产生多条。
    expect(records.length).toBe(1);
  });
});
