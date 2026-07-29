import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * R2 P0 测试：quiz attemptId 的持久化生命周期。
 * 核心断言：确定性 ID 锚定在 localStorage 持久化字段上——
 * 刷新（内存态丢失）后重试/继续仍复用同一 attemptId，clearSubmitted 后才生成新值。
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
const cryptoStub = {
  randomUUID: () => `uuid-${++uuidCounter}`,
};

vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });
vi.stubGlobal('crypto', cryptoStub);

import {
  ATTEMPT_ID_PREFIX,
  clearAllForScene,
  clearSubmitted,
  readAttemptId,
  writeSubmittedAnswers,
} from '@/lib/quiz/persistence';

describe('quiz attemptId lifecycle (R2 P0)', () => {
  beforeEach(() => {
    localStorageStub.clear();
    uuidCounter = 0;
  });

  it('writeSubmittedAnswers persists attemptId in the same write as answers', () => {
    writeSubmittedAnswers('s1', { q1: 'a' });
    expect(store[ATTEMPT_ID_PREFIX + 's1']).toBe('uuid-1');
    expect(readAttemptId('s1')).toBe('uuid-1');
    expect(store['quizAnswers:s1']).toBeDefined();
  });

  it('reuses the persisted attemptId across simulated refresh (memory lost, localStorage kept)', () => {
    writeSubmittedAnswers('s1', { q1: 'a' });
    const first = readAttemptId('s1');
    // 模拟刷新：本模块无内存态，localStorage 即真相——再次提交（重试影子写场景）
    // 必须复用同一 attemptId，从而定位同一 runtime 会话
    writeSubmittedAnswers('s1', { q1: 'a', q2: 'b' });
    expect(readAttemptId('s1')).toBe(first);
  });

  it('does not generate attemptId during draft phase (only on submit)', () => {
    // draft 由 useDraftCache 直写 quizDraft:*，不经过 writeSubmittedAnswers
    store['quizDraft:s1'] = JSON.stringify({ q1: 'drafting' });
    expect(readAttemptId('s1')).toBeNull();
  });

  it('clearSubmitted clears attemptId so the next submit starts a new attempt', () => {
    writeSubmittedAnswers('s1', { q1: 'a' });
    const first = readAttemptId('s1');
    clearSubmitted('s1');
    expect(readAttemptId('s1')).toBeNull();
    writeSubmittedAnswers('s1', { q1: 'a2' });
    const second = readAttemptId('s1');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('clearAllForScene wipes attemptId together with the other keys', () => {
    writeSubmittedAnswers('s1', { q1: 'a' });
    clearAllForScene('s1');
    expect(readAttemptId('s1')).toBeNull();
    expect(store['quizAnswers:s1']).toBeUndefined();
  });

  it('attemptId is per-scene isolated', () => {
    writeSubmittedAnswers('s1', { q1: 'a' });
    writeSubmittedAnswers('s2', { q1: 'b' });
    expect(readAttemptId('s1')).not.toBe(readAttemptId('s2'));
  });
});
