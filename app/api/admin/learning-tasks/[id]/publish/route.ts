/**
 * POST /api/admin/learning-tasks/[id]/publish  — 发布任务（RPC 原子+并发安全）
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { getServiceSupabase } from '@/lib/supabase/server';
import { checkTaskManagePermission } from '@/lib/server/learning-tasks/permissions';
import { computeCourseDataHash } from '@/lib/server/learning-tasks/course-snapshot';

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

    const perm = await checkTaskManagePermission(user.id, taskId);
    if (!perm.ok) {
      return NextResponse.json(
        { success: false, error: '无权发布此任务', errorCode: 'FORBIDDEN' },
        { status: 403 },
      );
    }

    const svc = getServiceSupabase();

    // 查任务 course_id 再查课程 data 计算 canonical hash（TS 单层唯一 hash 来源）
    const { data: task } = await svc
      .from('learning_tasks')
      .select('course_id')
      .eq('id', taskId)
      .maybeSingle();
    const courseId = (task as { course_id?: string })?.course_id ?? '';
    const { data: course } = await svc
      .from('courses')
      .select('data')
      .eq('id', courseId)
      .maybeSingle();
    const sourceHash = computeCourseDataHash((course as { data?: unknown })?.data);

    const { data: rpcResult, error: rpcError } = await svc.rpc('publish_task', {
      p_task_id: taskId,
      p_user_id: user.id,
      p_source_hash: sourceHash,
    });

    if (rpcError) {
      if (rpcError.message.includes('TASK_NOT_FOUND')) {
        return NextResponse.json(
          { success: false, error: '任务不存在', errorCode: 'TASK_NOT_FOUND' },
          { status: 404 },
        );
      }
      if (rpcError.message.includes('Only draft') || rpcError.message.includes('TASK_NOT_DRAFT')) {
        return NextResponse.json(
          { success: false, error: '非草稿状态不可发布', errorCode: 'TASK_NOT_DRAFT' },
          { status: 400 },
        );
      }
      if (
        rpcError.message.includes('No assigned learners') ||
        rpcError.message.includes('TASK_EMPTY_ROSTER')
      ) {
        return NextResponse.json(
          { success: false, error: '任务没有分配学员', errorCode: 'TASK_EMPTY_ROSTER' },
          { status: 400 },
        );
      }
      if (rpcError.message.includes('COURSE_NOT_FOUND')) {
        return NextResponse.json(
          { success: false, error: '课程不存在', errorCode: 'COURSE_NOT_FOUND' },
          { status: 404 },
        );
      }
      throw rpcError;
    }

    const result = rpcResult as Record<string, unknown>;
    return NextResponse.json({
      success: true,
      data: {
        id: taskId,
        status: result.status,
        snapshot_id: result.snapshot_id,
        share_token: result.share_token,
        published: result.published,
      },
    });
  } catch (error: unknown) {
    console.error('[admin/learning-tasks/[id]/publish] failed:', error);
    return NextResponse.json(
      { success: false, error: '发布任务失败', errorCode: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
