/**
 * GET /api/learn/[token]  — 学员入口（先鉴权再返回任何信息）
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { getServiceSupabase } from '@/lib/supabase/server';
import { checkTaskEntryPermission } from '@/lib/server/learning-tasks/permissions';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

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

    const svc = getServiceSupabase();

    // 查 token
    const { data: task, error: taskError } = await svc
      .from('learning_tasks')
      .select('id, course_id, title, description, status, task_type, start_at, due_at, snapshot_id')
      .eq('share_token', token)
      .maybeSingle();

    if (taskError) throw taskError;
    if (!task || task.status !== 'published') {
      return NextResponse.json(
        { success: false, error: '任务不存在或未发布', errorCode: 'TASK_NOT_FOUND' },
        { status: 404 },
      );
    }

    // 先鉴权
    const entry = await checkTaskEntryPermission(user.id, task.id as string);

    if (!entry.ok) {
      const ec =
        entry.reason === 'learner_not_bound'
          ? 'LEARNER_NOT_BOUND'
          : entry.reason === 'learner_disabled'
            ? 'LEARNER_DISABLED'
            : 'FORBIDDEN';
      return NextResponse.json(
        { success: false, error: '无权进入此任务', errorCode: ec },
        { status: 403 },
      );
    }

    // 鉴权通过后检查时间
    if (
      entry.actor === 'learner' &&
      task.start_at &&
      new Date(task.start_at as string) > new Date()
    ) {
      return NextResponse.json({
        success: true,
        data: {
          taskId: task.id,
          title: task.title,
          status: 'not_started_yet',
          startAt: task.start_at,
        },
      });
    }

    // 构建安全响应
    const response: Record<string, unknown> = {
      taskId: task.id,
      courseId: task.course_id,
      title: task.title,
      description: task.description,
      taskType: task.task_type,
      startAt: task.start_at,
      dueAt: task.due_at,
    };

    if (entry.actor === 'preview') {
      response.role = entry.role;
      response.isPreview = true;
    } else {
      response.studentId = entry.studentId;
    }

    return NextResponse.json({ success: true, data: response });
  } catch (error: unknown) {
    console.error('[learn/[token]] failed:', error);
    return NextResponse.json(
      { success: false, error: '获取学习入口失败', errorCode: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
