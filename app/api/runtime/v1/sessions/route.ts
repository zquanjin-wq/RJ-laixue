/**
 * app/api/runtime/v1/sessions/route.ts
 *
 * RJ-contract-v1:
 *   POST /api/runtime/v1/sessions          → createSession
 *   GET  /api/runtime/v1/sessions?stageId= → listSessions（learnerKey 强制 = auth.uid()）
 */
import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { rateLimitByUser } from '@/lib/server/api-guard';
import { requireRuntimeUser, makeRuntimeStore } from '@/lib/server/runtime-store/request-context';
import { runtimeStoreErrorResponse } from '@/lib/server/runtime-store/http-error';
import { checkCourseReadAccess } from '@/lib/server/course-access';

export async function POST(req: NextRequest) {
  const guard = await requireRuntimeUser();
  if (!guard.ok) return guard.response;
  const rl = rateLimitByUser(guard.user.id, 'runtime-create-session', 30, 60_000);
  if (!rl.ok) return rl.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, '请求体不是合法 JSON');
  }
  const { id, kind, stageId, status, createdAt, updatedAt, share } = body as {
    id?: string; kind?: string; stageId?: string; status?: string;
    createdAt?: string; updatedAt?: string; share?: boolean;
  };
  if (!id || !kind || !stageId || !status || !createdAt || !updatedAt) {
    return apiError(
      'MISSING_REQUIRED_FIELD', 400,
      'id / kind / stageId / status / createdAt / updatedAt 均为必填',
    );
  }
  // stageId == courseId：与 courses GET 同一判定（R1.1 补授权缺口——此前任何
  // 登录用户可在任意 courseId 下建会话）。会话写入的是 learner 自己的分区，
  // 但课程不可读就意味着不该产生任何运行时数据。
  const access = await checkCourseReadAccess(guard.user.id, stageId, {
    shareLink: share === true,
  });
  if (!access.ok) {
    if (access.reason === 'not_found') {
      return apiError('NOT_FOUND', 404, '课程不存在');
    }
    return apiError('FORBIDDEN', 403, '您没有权限在该课程下创建学习会话');
  }
  try {
    // learnerKey 由服务端注入登录用户 id——客户端自报的一律忽略（防越权写入他人分区）
    const session = await makeRuntimeStore().createSession({
      id, kind, stageId, learnerKey: guard.user.id,
      status: status as 'active' | 'completed' | 'archived',
      createdAt, updatedAt,
    });
    return apiSuccess({ session }, 201);
  } catch (err) {
    return runtimeStoreErrorResponse(err);
  }
}

export async function GET(req: NextRequest) {
  const guard = await requireRuntimeUser();
  if (!guard.ok) return guard.response;
  const rl = rateLimitByUser(guard.user.id, 'runtime-list-sessions', 120, 60_000);
  if (!rl.ok) return rl.response;

  const stageId = req.nextUrl.searchParams.get('stageId');
  if (!stageId) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId 查询参数必填');
  }
  try {
    const sessions = await makeRuntimeStore().listSessions(stageId, guard.user.id);
    return apiSuccess({ sessions });
  } catch (err) {
    return runtimeStoreErrorResponse(err);
  }
}
