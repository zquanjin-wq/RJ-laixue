/**
 * app/api/runtime/v1/sessions/[sessionId]/route.ts
 *
 * RJ-contract-v1:
 *   GET    /api/runtime/v1/sessions/{sessionId} → getSession（仅本人分区）
 *   DELETE /api/runtime/v1/sessions/{sessionId} → deleteSession（幂等，级联 records）
 */
import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { rateLimitByUser } from '@/lib/server/api-guard';
import { requireRuntimeUser, makeRuntimeStore } from '@/lib/server/runtime-store/request-context';
import { runtimeStoreErrorResponse } from '@/lib/server/runtime-store/http-error';

type Ctx = { params: Promise<{ sessionId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const guard = await requireRuntimeUser();
  if (!guard.ok) return guard.response;
  const rl = rateLimitByUser(guard.user.id, 'runtime-get-session', 120, 60_000);
  if (!rl.ok) return rl.response;

  const { sessionId } = await params;
  try {
    const session = await makeRuntimeStore().getSession(sessionId);
    if (!session) return apiError('NOT_FOUND', 404, `no session ${sessionId}`);
    if (session.learnerKey !== guard.user.id) {
      return apiError('FORBIDDEN', 403, '无权访问他人的课堂运行数据');
    }
    return apiSuccess({ session });
  } catch (err) {
    return runtimeStoreErrorResponse(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const guard = await requireRuntimeUser();
  if (!guard.ok) return guard.response;
  const rl = rateLimitByUser(guard.user.id, 'runtime-delete-session', 30, 60_000);
  if (!rl.ok) return rl.response;

  const { sessionId } = await params;
  try {
    const store = makeRuntimeStore();
    // 幂等删除 + 归属校验：会话存在且非本人 → 403；不存在 → 直接成功（幂等语义）
    const session = await store.getSession(sessionId);
    if (session && session.learnerKey !== guard.user.id) {
      return apiError('FORBIDDEN', 403, '无权删除他人的课堂运行数据');
    }
    await store.deleteSession(sessionId);
    return apiSuccess({ deleted: true });
  } catch (err) {
    return runtimeStoreErrorResponse(err);
  }
}
