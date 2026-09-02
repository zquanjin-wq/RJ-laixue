/**
 * lib/server/runtime-store/http-error.ts
 *
 * RuntimeStore 抛出的错误 → RJ-contract-v1 错误响应的映射。
 * store 层错误是带模式消息的 Error（与 browser 后端同词表），这里按词表
 * 映射到 HTTP 状态 + errorCode（api-response.ts 形状）。
 */
import type { NextResponse } from 'next/server';
import { apiError, type ApiErrorCode } from '@/lib/server/api-response';

interface MappedError {
  code: ApiErrorCode | 'NOT_FOUND' | 'CONFLICT' | 'FUTURE_VERSION' | 'INACTIVE_SESSION' | 'IDEMPOTENCY_CONFLICT' | 'INVALID_ENVELOPE';
  status: number;
}

export function mapRuntimeStoreError(err: unknown): { mapped: MappedError; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const cases: [RegExp, MappedError][] = [
    [/already exists/, { code: 'CONFLICT', status: 409 }],
    [/no session/, { code: 'NOT_FOUND', status: 404 }],
    [/newer than this client/, { code: 'FUTURE_VERSION', status: 409 }],
    [/only be appended to an active session/, { code: 'INACTIVE_SESSION', status: 409 }],
    [/IDEMPOTENCY_CONFLICT/, { code: 'IDEMPOTENCY_CONFLICT', status: 409 }],
    [/non-empty strings/, { code: 'INVALID_REQUEST', status: 400 }],
    [/invalid (runtime|stored)/, { code: 'INVALID_ENVELOPE', status: 400 }],
    [/concurrently modified/, { code: 'CONFLICT', status: 409 }],
  ];
  for (const [pattern, mapped] of cases) {
    if (pattern.test(message)) return { mapped, message };
  }
  return { mapped: { code: 'INTERNAL_ERROR', status: 500 }, message };
}

/** 便捷出口：把 store 调用包成「成功返回结果 / 失败返回 NextResponse」。 */
export function runtimeStoreErrorResponse(err: unknown): NextResponse {
  const { mapped, message } = mapRuntimeStoreError(err);
  return apiError(mapped.code as ApiErrorCode, mapped.status, message);
}
