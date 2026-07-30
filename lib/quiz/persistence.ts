import type { QuestionResult } from '@/lib/quiz/grading';

/**
 * Quiz state persistence in localStorage, keyed per scene.
 *
 * Three keys coexist with distinct lifecycles:
 *
 *   quizDraft:<sceneId>    — in-progress answers (debounced via useDraftCache),
 *                            cleared at submit time.
 *   quizAnswers:<sceneId>  — 提交 envelope（{v, attemptId, answers}）：R2 起
 *                            attemptId 与 answers 同一次原子写入（Codex 验收卡）；
 *                            cleared on retry。读路径兼容 envelope 之前的裸 answers。
 *   quizResults:<sceneId>  — graded results written once at reviewing, cleared on retry.
 *
 * （已废弃）quizAttemptId:<sceneId> — R2 初版的双键方案已被单键 envelope 取代，
 * 仅在 clear* 中做遗留清理。
 *
 * Both quiz-view (to rehydrate its own state) and the classroom-complete page
 * (to compute aggregate scores) read through this module so the storage
 * schema is a single source of truth.
 */

export const DRAFT_KEY_PREFIX = 'quizDraft:';
export const ANSWERS_KEY_PREFIX = 'quizAnswers:';
export const RESULTS_KEY_PREFIX = 'quizResults:';
/** 已废弃：R2 初版双键方案的遗留键，仅用于 clear* 清理。新代码一律走 envelope。 */
export const ATTEMPT_ID_PREFIX = 'quizAttemptId:';

/** Build the draft cache key for a scene. Use this everywhere that needs the
 *  in-progress quiz answers (e.g. `useDraftCache`) so the prefix stays in
 *  sync with the readers/clearers below. */
export const draftKey = (sceneId: string): string => DRAFT_KEY_PREFIX + sceneId;

export type QuizAnswers = Record<string, string | string[]>;

export type SubmittedState =
  | { kind: 'reviewing'; answers: QuizAnswers; results: QuestionResult[] }
  | { kind: 'answering'; answers: QuizAnswers }
  | null;

function safeGet(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore quota / disabled storage
  }
}

function safeRemove(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** Read quiz-view's post-submit state: answers + optional graded results. */
export function readSubmittedState(sceneId: string): SubmittedState {
  const answers = parseAnswers(safeGet(ANSWERS_KEY_PREFIX + sceneId));
  if (!answers) return null;
  const rawR = safeGet(RESULTS_KEY_PREFIX + sceneId);
  if (rawR) {
    try {
      const results = JSON.parse(rawR) as QuestionResult[];
      if (Array.isArray(results) && results.length > 0) {
        return { kind: 'reviewing', answers, results };
      }
    } catch {
      /* fall through */
    }
  }
  return { kind: 'answering', answers };
}

/**
 * Convenience reader for the classroom-complete page: returns the submitted
 * answers if present, else falls back to the in-progress draft so a partial
 * attempt still contributes to the aggregate instead of showing 0/N.
 */
export function readAnswersForSummary(sceneId: string): QuizAnswers {
  const answers = parseAnswers(safeGet(ANSWERS_KEY_PREFIX + sceneId));
  if (answers) return answers;
  const rawD = safeGet(DRAFT_KEY_PREFIX + sceneId);
  if (rawD) {
    try {
      return JSON.parse(rawD) as QuizAnswers;
    } catch {
      /* fall through */
    }
  }
  return {};
}

// ─── R2 提交 envelope（Codex 验收卡修订，2026-07-30）────────────────────────
//
// 初版 R2 把 attemptId 与 answers 分两个键写（setItem × 2），不具备跨键原子性：
// 第二次写失败会留下孤立 attemptId，且 safeSet 吞错使调用方无法察觉。
// 验收卡裁决：改为单键提交 envelope——一次 setItem 要么整体成功要么整体失败，
// 不存在孤立 attemptId。safeSet 吞错不再影响正确性：影子路径只认从 localStorage
// 读回的 envelope（readSubmittedEnvelope），写失败时读不到就不发影子请求——
// 「影子写是持久化状态的函数，不是内存状态的函数」。

const ENVELOPE_VERSION = 1;

/** quizAnswers:<sceneId> 的提交 envelope：attemptId 与 answers 同一次原子写入。 */
export interface SubmittedEnvelope {
  v: number;
  attemptId: string;
  answers: QuizAnswers;
}

/** 解析提交 envelope；legacy 裸 answers（envelope 之前的格式）返回 null。 */
function parseEnvelope(raw: string | null): SubmittedEnvelope | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SubmittedEnvelope> | null;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.attemptId === 'string' &&
      parsed.answers &&
      typeof parsed.answers === 'object' &&
      !Array.isArray(parsed.answers)
    ) {
      return {
        v: typeof parsed.v === 'number' ? parsed.v : ENVELOPE_VERSION,
        attemptId: parsed.attemptId,
        answers: parsed.answers as QuizAnswers,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 兼容读取 answers：envelope 拆包；legacy 裸 answers 原样返回。 */
function parseAnswers(raw: string | null): QuizAnswers | null {
  const envelope = parseEnvelope(raw);
  if (envelope) return envelope.answers;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as QuizAnswers;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Called by quiz-view at submit time. */
export function writeSubmittedAnswers(sceneId: string, answers: QuizAnswers): void {
  // 复用本周期已有 attemptId（刷新后继续/重试影子写场景）；retry
  // （clearSubmitted）已删除整个 envelope，下一周期自然生成新 id。
  const attemptId = readSubmittedEnvelope(sceneId)?.attemptId ?? crypto.randomUUID();
  const envelope: SubmittedEnvelope = { v: ENVELOPE_VERSION, attemptId, answers };
  safeSet(ANSWERS_KEY_PREFIX + sceneId, JSON.stringify(envelope));
}

/**
 * R2 影子写读取当前答题周期的持久化 envelope；无（尚未提交 / 写失败 /
 * legacy 裸 answers 格式）返回 null。影子路径只准使用本函数读回的数据，
 * 禁止使用调用方内存里的 answers/attemptId。
 */
export function readSubmittedEnvelope(sceneId: string): SubmittedEnvelope | null {
  return parseEnvelope(safeGet(ANSWERS_KEY_PREFIX + sceneId));
}

/** R2 影子写读取当前答题周期 id；无（尚未提交过/写失败/legacy 格式）返回 null。 */
export function readAttemptId(sceneId: string): string | null {
  return readSubmittedEnvelope(sceneId)?.attemptId ?? null;
}

/** Called by quiz-view when grading transitions to reviewing. */
export function writeSubmittedResults(sceneId: string, results: QuestionResult[]): void {
  safeSet(RESULTS_KEY_PREFIX + sceneId, JSON.stringify(results));
}

/** Called by quiz-view on retry: wipes submitted answers + results but keeps draft lifecycle. */
export function clearSubmitted(sceneId: string): void {
  // 删除提交 envelope 即完成周期归档——attemptId 随 envelope 一起消失，
  // 下一次 writeSubmittedAnswers 生成新周期 id（单键原子，无孤立 attemptId 可能）
  safeRemove(ANSWERS_KEY_PREFIX + sceneId);
  safeRemove(RESULTS_KEY_PREFIX + sceneId);
  // 遗留清理：R2 初版双键方案的 attemptId 键（如有）
  safeRemove(ATTEMPT_ID_PREFIX + sceneId);
}

/** Called by the stage-delete flow: wipes all three keys for a single scene. */
export function clearAllForScene(sceneId: string): void {
  safeRemove(DRAFT_KEY_PREFIX + sceneId);
  safeRemove(ANSWERS_KEY_PREFIX + sceneId);
  safeRemove(RESULTS_KEY_PREFIX + sceneId);
  safeRemove(ATTEMPT_ID_PREFIX + sceneId);
}
