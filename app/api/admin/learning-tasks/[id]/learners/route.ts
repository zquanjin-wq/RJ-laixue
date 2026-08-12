/**
 * PUT /api/admin/learning-tasks/[id]/learners  — 替换学员名单（RPC 原子事务）
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { getServiceSupabase } from '@/lib/supabase/server';
import { checkTaskManagePermission } from '@/lib/server/learning-tasks/permissions';

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: '无效的 JSON 请求体', errorCode: 'INVALID_BODY' },
      { status: 400 },
    );
  }

  const learnerIds: string[] = Array.isArray(body.learnerIds)
    ? [...new Set(body.learnerIds.filter((id: unknown) => typeof id === 'string'))]
    : [];

  if (learnerIds.length === 0) {
    return NextResponse.json(
      { success: false, error: '学员名单不能为空', errorCode: 'INVALID_LEARNERS' },
      { status: 400 },
    );
  }

  try {
    const serverSupabase = await getServerSupabase();
    const {
      data: { user },
    } = await serverSupabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { success: false, error: '未登录', errorCode: 'UNAUTHENTICATED' },
        { status: 401 },
      );
    }

    const perm = await checkTaskManagePermission(user.id, taskId);
    if (!perm.ok) {
      return NextResponse.json(
        { success: false, error: '无权修改此任务', errorCode: 'FORBIDDEN' },
        { status: 403 },
      );
    }

    const svc = getServiceSupabase();

    // 使用 RPC 原子替换
    const { data: rpcResult, error: rpcError } = await svc.rpc('replace_task_learners', {
      p_task_id: taskId,
      p_learner_ids: learnerIds,
    });

    if (rpcError) {
      if (rpcError.message.includes('Only draft') || rpcError.message.includes('TASK_NOT_DRAFT')) {
        return NextResponse.json(
          { success: false, error: '只能修改草稿任务学员名单', errorCode: 'TASK_NOT_DRAFT' },
          { status: 400 },
        );
      }
      if (rpcError.message.includes('No valid')) {
        return NextResponse.json(
          { success: false, error: '无有效学员', errorCode: 'INVALID_LEARNERS' },
          { status: 400 },
        );
      }
      throw rpcError;
    }

    // 读取最新名单
    const { data: learners } = await svc
      .from('task_learners')
      .select('id, student_id, status, assigned_at')
      .eq('task_id', taskId);

    return NextResponse.json({ success: true, data: learners ?? [] });
  } catch (error: unknown) {
    console.error('[admin/learning-tasks/[id]/learners] put failed:', error);
    return NextResponse.json(
      { success: false, error: '更新学员名单失败', errorCode: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
