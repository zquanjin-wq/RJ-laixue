/**
 * app/api/runtime/v1/learners/merge/route.ts
 *
 * RJ-contract-v1:
 *   POST /api/runtime/v1/learners/merge → mergeLearner
 *   body: { fromLearnerKey, grantId }
 *
 * 拍板的安全决策（R0 第 5 节，负责人已同意）：
 *   - toLearnerKey 强制 = auth.uid()（不接受客户端传入）；
 *   - 必须携带 access-code 绑定流程签发的短期一次性 grant（runtime_merge_grants），
 *     客户端自报 fromLearnerKey 一律 403——否则任意匿名分区可被劫走；
 *   - grant 原子核销（runtime_claim_merge_grant），核销与 merge 顺序执行：
 *     claim 成功才 merge；merge 失败 grant 已核销（一次性语义，防重放爆破）。
 */
import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { rateLimitByUser } from '@/lib/server/api-guard';
import { requireRuntimeUser, makeRuntimeStore } from '@/lib/server/runtime-store/request-context';
import { runtimeStoreErrorResponse } from '@/lib/server/runtime-store/http-error';
import { getServiceSupabase } from '@/lib/supabase/server';

export async function POST(req: NextRequest) {
  const guard = await requireRuntimeUser();
  if (!guard.ok) return guard.response;
  const rl = rateLimitByUser(guard.user.id, 'runtime-merge-learner', 5, 60_000);
  if (!rl.ok) return rl.response;

  let body: { fromLearnerKey?: string; grantId?: string };
  try {
    body = await req.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, '请求体不是合法 JSON');
  }
  if (!body.fromLearnerKey || !body.grantId) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'fromLearnerKey 与 grantId 均为必填');
  }
  if (body.fromLearnerKey === guard.user.id) {
    // 自合并：契约返回 0，无需 grant（无数据移动，无安全风险）
    return apiSuccess({ moved: 0 });
  }
  try {
    // 1) 原子核销 grant（一次性、短期；核销失败 = 无权 merge）
    const { data: claim, error: claimErr } = await getServiceSupabase().rpc(
      'runtime_claim_merge_grant',
      {
        p_grant_id: body.grantId,
        p_from: body.fromLearnerKey,
        p_to: guard.user.id,
        p_now: new Date().toISOString(),
      },
    );
    if (claimErr) {
      return apiError('INTERNAL_ERROR', 500, `grant 核销失败：${claimErr.message}`);
    }
    if (claim !== 'ok') {
      return apiError('FORBIDDEN', 403, 'merge 授权无效、已过期或已使用');
    }
    // 2) grant 有效 → 执行合并
    const moved = await makeRuntimeStore().mergeLearner(body.fromLearnerKey, guard.user.id);
    return apiSuccess({ moved });
  } catch (err) {
    return runtimeStoreErrorResponse(err);
  }
}
