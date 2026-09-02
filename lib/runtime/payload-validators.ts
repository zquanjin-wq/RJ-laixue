/**
 * lib/runtime/payload-validators.ts
 *
 * RuntimeStore 的 per-kind payload 校验映射——browser 端 BrowserRuntimeStore
 * 与服务端 RuntimeStorePg 共用同一来源，杜绝两端校验漂移。
 *
 * 模式与 widened scene kind 的方案 A 先例一致（lib/dsl-extensions/validate.ts）：
 * DSL 骨架只管 chat / quizAttempt；RJ 自有 kind（playback 等）在此注册。
 * 注意 payloadValidators 在 BrowserRuntimeStore 是「整体替换」语义（不是合并），
 * 所以本模块必须给出完整映射，不能只给增量。
 */
import { isChatMessageSkeleton, isQuizAttemptSkeleton } from '@openmaic/dsl';
import type { RuntimePayloadValidator } from '@openmaic/storage';

const skeletonGate = (
  guard: (p: unknown) => boolean,
  message: string,
): RuntimePayloadValidator => (payload) =>
  guard(payload)
    ? { valid: true }
    : { valid: false, errors: [{ path: '/payload', message }] };

/**
 * 默认映射：DSL 骨架 kind 用骨架守卫；未列出的 kind（如 playback、RJ 多智能体
 * 课堂的自有 kind）app-owned，存储层不检查。新增 RJ 自有 kind 且需要服务端
 * 校验时在此注册。
 */
export const RJ_RUNTIME_PAYLOAD_VALIDATORS: Record<string, RuntimePayloadValidator> = {
  chat: skeletonGate(
    isChatMessageSkeleton,
    'chat payload must match ChatMessageSkeleton (role + content)',
  ),
  quizAttempt: skeletonGate(
    isQuizAttemptSkeleton,
    'quizAttempt payload must match QuizAttemptSkeleton (phase + answers)',
  ),
};
