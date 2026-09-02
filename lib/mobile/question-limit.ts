/**
 * lib/mobile/question-limit.ts
 *
 * Per-course question counter for the mobile client-side limit.
 * Pilot policy: max 5 questions per course (per PRD-mobile.md §3.1).
 *
 * Stored in localStorage. Trust-on-client for the pilot; Phase 2
 * will add server-side enforcement (counts live in
 * `course_progress_events` already).
 */

const STORAGE_PREFIX = 'mobile.questions.';
const PILOT_LIMIT = 5;

export interface QuestionCounter {
  /** Course ID this counter belongs to. */
  courseId: string;
  /** Number of questions already asked in this course. */
  used: number;
}

export function getQuestionCount(courseId: string): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + courseId);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as QuestionCounter;
    return parsed.used ?? 0;
  } catch {
    return 0;
  }
}

export function incrementQuestionCount(courseId: string): number {
  if (typeof window === 'undefined') return 0;
  const next = getQuestionCount(courseId) + 1;
  try {
    window.localStorage.setItem(
      STORAGE_PREFIX + courseId,
      JSON.stringify({ courseId, used: next } satisfies QuestionCounter),
    );
  } catch {
    // ignore quota / private-mode errors
  }
  return next;
}

export function resetQuestionCount(courseId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_PREFIX + courseId);
  } catch {
    // ignore
  }
}

export function questionsRemaining(courseId: string): number {
  return Math.max(0, PILOT_LIMIT - getQuestionCount(courseId));
}

export function hasQuestionsRemaining(courseId: string): boolean {
  return questionsRemaining(courseId) > 0;
}

export const QUESTION_LIMIT = PILOT_LIMIT;