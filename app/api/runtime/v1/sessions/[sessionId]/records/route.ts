/**
 * app/api/runtime/v1/sessions/[sessionId]/records/route.ts
 *
 * RJ-contract-v1:
 *   POST /api/runtime/v1/sessions/{sessionId}/records → appendRecord
 *         （seq 服务端分配；幂等：同 record id 同内容重放返回已有行，
 *          同 id 不同内容 409 IDEMPOTENCY_CONFLICT）
 *   GET  /api/runtime/v1/sessions/{sessionId}/records?sceneId= → listRecords（seq 序）
 */
import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { rateLimitByUser } from '@/lib/server/api-guard';
import { requireRuntimeUser, makeRuntimeStore } from '@/lib/server/runtime-store/request-context';
import { runtimeStoreErrorResponse } from '@/lib/server/runtime-store/http-error';
import type { RuntimeRecordInit } from '@openmaic/dsl';

type Ctx = { params: Promise<{ sessionId: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const guard = await requireRuntimeUser();
  if (!guard.ok) return guard.response;
  // 课堂高频互动：append 配额放宽到 120 次/分/用户
  const rl = rateLimitByUser(guard.user.id, 'runtime-append-record', 120, 60_000);
  if (!rl.ok) return rl.response;

  const { sessionId } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, '请求体不是合法 JSON');
  }
  const { id, createdAt } = body as { id?: string; createdAt?: string };
  if (!id || !createdAt || !('payload' in body)) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'id / createdAt / payload 均为必填');
  }
  try {
    const store = makeRuntimeStore();
    const session = await store.getSession(sessionId);
    if (!session) return apiError('NOT_FOUND', 404, `no session ${sessionId}`);
    if (session.learnerKey !== guard.user.id) {
      return apiError('FORBIDDEN', 403, '无权向他人的课堂会话写入记录');
    }
    const init: RuntimeRecordInit = {
      id,
      sessionId,
      createdAt,
      payload: body.payload,
      ...(typeof body.sceneId === 'string' ? { sceneId: body.sceneId } : {}),
      ...(typeof body.actionIndex === 'number' ? { actionIndex: body.actionIndex } : {}),
      ...(typeof body.subAnchor === 'string' ? { subAnchor: body.subAnchor } : {}),
    } as RuntimeRecordInit;
    const record = await store.appendRecord(init);
    return apiSuccess({ record }, 201);
  } catch (err) {
    return runtimeStoreErrorResponse(err);
  }
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const guard = await requireRuntimeUser();
  if (!guard.ok) return guard.response;
  const rl = rateLimitByUser(guard.user.id, 'runtime-list-records', 120, 60_000);
  if (!rl.ok) return rl.response;

  const { sessionId } = await params;
  const sceneId = req.nextUrl.searchParams.get('sceneId') ?? undefined;
  try {
    const store = makeRuntimeStore();
    const session = await store.getSession(sessionId);
    if (!session) return apiError('NOT_FOUND', 404, `no session ${sessionId}`);
    if (session.learnerKey !== guard.user.id) {
      return apiError('FORBIDDEN', 403, '无权读取他人的课堂运行数据');
    }
    const records = await store.listRecords(sessionId, sceneId ? { sceneId } : undefined);
    return apiSuccess({ records });
  } catch (err) {
    return runtimeStoreErrorResponse(err);
  }
}
