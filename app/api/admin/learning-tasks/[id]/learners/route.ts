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
    const { data: task } = await svc
      .from('learning_tasks')
      .select('status')
      .eq('id', taskId)
      .maybeSingle();
    if (!task) {
      return NextResponse.json(
        { success: false, error: 'Task not found', errorCode: 'NOT_FOUND' },
        { status: 404 },
      );
    }

    // 草稿与已发布任务都支持调整名单；保留仍在名单中的既有学习记录。
    const { error: rpcError } = await svc.rpc('replace_task_learners', {
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
      .select(
        'id, student_id, status, progress_percent, completed_scene_count, total_scene_count, assigned_at',
      )
      .eq('task_id', taskId);
    const learnerIds = (learners ?? []).map((learner) => learner.student_id);
    const { data: profiles } = learnerIds.length
      ? await svc.from('students').select('id, name, email').in('id', learnerIds)
      : { data: [] };
    const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));

    return NextResponse.json({
      success: true,
      data: (learners ?? []).map((learner) => ({
        ...learner,
        name: profileById.get(learner.student_id)?.name ?? '未知人员',
        email: profileById.get(learner.student_id)?.email ?? null,
      })),
    });
  } catch (error: unknown) {
    console.error('[admin/learning-tasks/[id]/learners] put failed:', error);
    return NextResponse.json(
      { success: false, error: '更新学员名单失败', errorCode: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
