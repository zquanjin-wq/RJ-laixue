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
 *   - grant 校验 + 核销与数据搬移在单条原子 SQL（runtime_merge_with_grant）
 *     内完成：grant 无效（403）或版本冲突（迁移后重试）都不烧 grant，
 *     只有搬移真正成功才核销——v1.1 修复「claim 与 merge 分步导致失败烧
 *     grant」的竞态（docs/reports/2026-07-29-runtimestore-r1-concurrency-gap.md）。
 */
import { type NextRequest } from 'next/server';
import { RUNTIME_DSL_VERSION } from '@openmaic/dsl';
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
    const store = makeRuntimeStore();
    // 原子 merge：grant 校验 + 核销 + 搬移同一条 SQL。version_conflict 时
    // 先迁移该 learner 的过期版本行（不烧 grant）再重试一次。
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, error } = await getServiceSupabase().rpc('runtime_merge_with_grant', {
        p_grant_id: body.grantId,
        p_from: body.fromLearnerKey,
        p_to: guard.user.id,
        p_expect_version: RUNTIME_DSL_VERSION,
        p_now: new Date().toISOString(),
      });
      if (error) {
        return apiError('INTERNAL_ERROR', 500, `merge 执行失败：${error.message}`);
      }
      const outcome = String(data);
      if (outcome.startsWith('ok:')) {
        return apiSuccess({ moved: Number(outcome.slice('ok:'.length)) });
      }
      if (outcome === 'invalid_grant') {
        return apiError('FORBIDDEN', 403, 'merge 授权无效、已过期或已使用');
      }
      // 'version_conflict'：存在过期版本行——迁移后重试；再冲突则落入 500
      await store.migrateLearnerRuntime(body.fromLearnerKey);
    }
    return apiError('INTERNAL_ERROR', 500, 'merge 迁移后仍版本冲突，请重试');
  } catch (err) {
    return runtimeStoreErrorResponse(err);
  }
}
