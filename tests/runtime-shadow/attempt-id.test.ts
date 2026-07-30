import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * R2 P0 测试（Codex 验收卡修订版）：quiz 提交 envelope 的原子性生命周期。
 *
 * 验收卡裁决：初版「setItem(attemptId) + setItem(answers) 双键写」不具备跨键
 * 原子性，第二次失败会留下孤立 attemptId。修复：单键 envelope——attemptId 与
 * answers 同一次 setItem，要么整体成功要么整体失败。
 *
 * 本文件覆盖验收门禁：任一步写失败注入、刷新恢复、跨标签页、legacy 格式兼容。
 * 影子路径侧的「写失败 → 零影子请求」门禁见 shadow-writer.test.ts。
 */

const store: Record<string, string> = {};
let throwOnKeys: string[] = [];
const localStorageStub = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => {
    if (throwOnKeys.some((p) => k.startsWith(p))) {
      throw new Error('QuotaExceededError (injected)');
    }
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
  ANSWERS_KEY_PREFIX,
  ATTEMPT_ID_PREFIX,
  clearAllForScene,
  clearSubmitted,
  readAnswersForSummary,
  readAttemptId,
  readSubmittedEnvelope,
  readSubmittedState,
  writeSubmittedAnswers,
  writeSubmittedResults,
} from '@/lib/quiz/persistence';

describe('quiz submit envelope (R2 P0, Codex acceptance revision)', () => {
  beforeEach(() => {
    localStorageStub.clear();
    throwOnKeys = [];
    uuidCounter = 0;
  });

  // ─── 单键原子性 ────────────────────────────────────────────────────────

  it('attemptId and answers live in ONE key (single atomic setItem)', () => {
    writeSubmittedAnswers('s1', { q1: 'a' });
    const raw = store[ANSWERS_KEY_PREFIX + 's1'];
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw);
    expect(parsed.attemptId).toBe('uuid-1');
    expect(parsed.answers).toEqual({ q1: 'a' });
    // 不再产生独立的 attemptId 键
    expect(store[ATTEMPT_ID_PREFIX + 's1']).toBeUndefined();
  });

  it('injected write failure leaves NO orphan attemptId and NO partial state', () => {
    throwOnKeys = [ANSWERS_KEY_PREFIX];
    writeSubmittedAnswers('s1', { q1: 'a' }); // safeSet 吞错
    // 单键写失败 = 整体失败：读不到 envelope，attemptId 不存在
    expect(readSubmittedEnvelope('s1')).toBeNull();
    expect(readAttemptId('s1')).toBeNull();
    expect(readSubmittedState('s1')).toBeNull();
    // 失败后可恢复：解除故障重新提交，生成全新周期（uuid 计数证明重新生成）
    throwOnKeys = [];
    writeSubmittedAnswers('s1', { q1: 'a' });
    expect(readAttemptId('s1')).toBe('uuid-2');
  });

  // ─── 刷新恢复 ──────────────────────────────────────────────────────────

  it('refresh recovery: persisted attemptId is reused, never regenerated', () => {
    writeSubmittedAnswers('s1', { q1: 'a' });
    const first = readAttemptId('s1');
    // 模拟刷新：本模块无内存态，localStorage 即真相——刷新后继续/重试
    // 影子写必须复用同一 attemptId → 定位同一 runtime 会话
    writeSubmittedAnswers('s1', { q1: 'a', q2: 'b' });
    expect(readAttemptId('s1')).toBe(first);
    expect(readSubmittedEnvelope('s1')?.answers).toEqual({ q1: 'a', q2: 'b' });
  });

  // ─── 跨标签页 ──────────────────────────────────────────────────────────

  it('cross-tab: a second tab reads the same attemptId from the shared key', () => {
    // 标签页 A 提交
    writeSubmittedAnswers('s1', { q1: 'a' });
    const tabAAttempt = readAttemptId('s1');
    // 标签页 B（另一份模块内存，同一 localStorage）读回——必然是同一个 id，
    // 不可能各自生成导致同一会话分裂
    const tabBAttempt = readAttemptId('s1');
    expect(tabBAttempt).toBe(tabAAttempt);
    // 标签页 B 仅有 draft（未提交）时不得凭空产生 attemptId
    store['quizDraft:s2'] = JSON.stringify({ q1: 'drafting' });
    expect(readAttemptId('s2')).toBeNull();
  });

  // ─── 周期更替 ──────────────────────────────────────────────────────────

  it('clearSubmitted removes the whole envelope; next submit starts a new attempt', () => {
    writeSubmittedAnswers('s1', { q1: 'a' });
    const first = readAttemptId('s1');
    clearSubmitted('s1');
    expect(readSubmittedEnvelope('s1')).toBeNull();
    writeSubmittedAnswers('s1', { q1: 'a2' });
    const second = readAttemptId('s1');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('clearSubmitted also cleans the legacy dual-key attemptId residue', () => {
    store[ATTEMPT_ID_PREFIX + 's1'] = 'legacy-uuid';
    writeSubmittedAnswers('s1', { q1: 'a' });
    clearSubmitted('s1');
    expect(store[ATTEMPT_ID_PREFIX + 's1']).toBeUndefined();
  });

  it('clearAllForScene wipes envelope together with the other keys', () => {
    writeSubmittedAnswers('s1', { q1: 'a' });
    writeSubmittedResults('s1', [{ questionId: 'q1' } as never]);
    clearAllForScene('s1');
    expect(readSubmittedEnvelope('s1')).toBeNull();
    expect(readSubmittedState('s1')).toBeNull();
  });

  it('attemptId is per-scene isolated', () => {
    writeSubmittedAnswers('s1', { q1: 'a' });
    writeSubmittedAnswers('s2', { q1: 'b' });
    expect(readAttemptId('s1')).not.toBe(readAttemptId('s2'));
  });

  // ─── legacy 裸 answers 兼容（envelope 之前提交的存量数据） ──────────────

  it('legacy raw answers: read paths keep working, shadow path gets no attemptId', () => {
    store[ANSWERS_KEY_PREFIX + 's1'] = JSON.stringify({ q1: 'legacy' });
    // 业务读路径不受影响（读源零改动 + 向后兼容）
    expect(readSubmittedState('s1')).toEqual({ kind: 'answering', answers: { q1: 'legacy' } });
    expect(readAnswersForSummary('s1')).toEqual({ q1: 'legacy' });
    // 影子路径：legacy 数据没有 attemptId → 读不到 envelope → 不影子化（可接受：
    // 这些是 envelope 之前的存量提交，本就不在 R2 影子范围）
    expect(readSubmittedEnvelope('s1')).toBeNull();
    expect(readAttemptId('s1')).toBeNull();
  });

  it('legacy attempt upgraded on next submit (re-submit writes envelope)', () => {
    store[ANSWERS_KEY_PREFIX + 's1'] = JSON.stringify({ q1: 'legacy' });
    writeSubmittedAnswers('s1', { q1: 'new' });
    const envelope = readSubmittedEnvelope('s1');
    expect(envelope?.attemptId).toBe('uuid-1');
    expect(envelope?.answers).toEqual({ q1: 'new' });
  });
});
