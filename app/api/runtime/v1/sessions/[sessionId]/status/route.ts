/**
 * app/api/runtime/v1/sessions/[sessionId]/status/route.ts
 *
 * RJ-contract-v1:
 *   PATCH /api/runtime/v1/sessions/{sessionId}/status → setSessionStatus
 *   body: { status: 'active'|'completed'|'archived', updatedAt: ISO }
 *   （updatedAt 由调用方给——store 无时钟，同契约）
 */
import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { rateLimitByUser } from '@/lib/server/api-guard';
import { requireRuntimeUser, makeRuntimeStore } from '@/lib/server/runtime-store/request-context';
import { runtimeStoreErrorResponse } from '@/lib/server/runtime-store/http-error';
import type { RuntimeSessionStatus } from '@openmaic/dsl';

type Ctx = { params: Promise<{ sessionId: string }> };

const VALID_STATUS: RuntimeSessionStatus[] = ['active', 'completed', 'archived'];

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const guard = await requireRuntimeUser();
  if (!guard.ok) return guard.response;
  const rl = rateLimitByUser(guard.user.id, 'runtime-set-status', 60, 60_000);
  if (!rl.ok) return rl.response;

  const { sessionId } = await params;
  let body: { status?: string; updatedAt?: string };
  try {
    body = await req.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, '请求体不是合法 JSON');
  }
  if (!body.status || !VALID_STATUS.includes(body.status as RuntimeSessionStatus) || !body.updatedAt) {
    return apiError(
      'MISSING_REQUIRED_FIELD', 400,
      `status（${VALID_STATUS.join('/')}）与 updatedAt（ISO 时间戳）均为必填`,
    );
  }
  try {
    const store = makeRuntimeStore();
    const session = await store.getSession(sessionId);
    if (!session) return apiError('NOT_FOUND', 404, `no session ${sessionId}`);
    if (session.learnerKey !== guard.user.id) {
      return apiError('FORBIDDEN', 403, '无权修改他人的课堂运行数据');
    }
    await store.setSessionStatus(sessionId, body.status as RuntimeSessionStatus, body.updatedAt);
    return apiSuccess({ updated: true });
  } catch (err) {
    return runtimeStoreErrorResponse(err);
  }
}
