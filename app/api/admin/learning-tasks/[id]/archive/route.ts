/**
 * POST /api/admin/learning-tasks/[id]/archive  — 归档任务
 *
 * 状态机：
 *   draft -> archived（直接归档）
 *   published -> closed -> archived（先关后归）
 *   禁止逆向恢复
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { getServiceSupabase } from '@/lib/supabase/server';
import { checkTaskManagePermission } from '@/lib/server/learning-tasks/permissions';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;

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

    const permission = await checkTaskManagePermission(user.id, taskId);
    if (!permission.ok) {
      return NextResponse.json(
        { success: false, error: '无权归档此任务', errorCode: 'FORBIDDEN' },
        { status: 403 },
      );
    }

    const serviceSupabase = getServiceSupabase();

    const { data: task, error: taskError } = await serviceSupabase
      .from('learning_tasks')
      .select('id, status')
      .eq('id', taskId)
      .single();

    if (taskError || !task) {
      return NextResponse.json(
        { success: false, error: '任务不存在', errorCode: 'TASK_NOT_FOUND' },
        { status: 404 },
      );
    }

    let nextStatus: string;

    switch (task.status) {
      case 'draft':
        nextStatus = 'archived';
        break;
      case 'published':
        nextStatus = 'closed';
        break;
      case 'closed':
        nextStatus = 'archived';
        break;
      case 'archived':
        // 幂等
        return NextResponse.json({
          success: true,
          data: { id: task.id, status: 'archived' },
        });
      default:
        return NextResponse.json(
          { success: false, error: '无效的状态转换', errorCode: 'INVALID_TASK_TRANSITION' },
          { status: 400 },
        );
    }

    const { error: updateError } = await serviceSupabase
      .from('learning_tasks')
      .update({ status: nextStatus })
      .eq('id', taskId);

    if (updateError) throw updateError;

    return NextResponse.json({
      success: true,
      data: { id: task.id, status: nextStatus },
    });
  } catch (error: unknown) {
    console.error('[admin/learning-tasks/[id]/archive] failed:', error);
    return NextResponse.json(
      { success: false, error: '归档任务失败', errorCode: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
