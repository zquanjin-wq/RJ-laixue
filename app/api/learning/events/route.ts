import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import {
  getErrorMessage,
  recordLearningEvent,
  resolveLearningActor,
  type LearningEventType,
} from '@/lib/server/learning-mvp';

const VALID_EVENT_TYPES: LearningEventType[] = ['open_course', 'view_scene', 'complete_course'];

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: '无效的 JSON 请求体', errorCode: 'INVALID_BODY' },
      { status: 400 },
    );
  }

  const courseId = typeof body.courseId === 'string' ? body.courseId : '';
  const eventType = typeof body.eventType === 'string' ? body.eventType : '';
  const taskId = typeof body.taskId === 'string' && body.taskId ? body.taskId : undefined;

  if (!courseId) {
    return NextResponse.json(
      { success: false, error: '缺少课程 ID', errorCode: 'MISSING_COURSE_ID' },
      { status: 400 },
    );
  }

  if (!VALID_EVENT_TYPES.includes(eventType as LearningEventType)) {
    return NextResponse.json(
      { success: false, error: '无效的学习事件类型', errorCode: 'INVALID_EVENT_TYPE' },
      { status: 400 },
    );
  }

  // 使用 getServerSupabase() 读取当前 user
  let userId: string | undefined;
  try {
    const serverSupabase = await getServerSupabase();
    const {
      data: { user },
      error: authError,
    } = await serverSupabase.auth.getUser();
    if (authError) throw authError;
    userId = user?.id;
  } catch (error: unknown) {
    const isSessionMissing =
      error instanceof Error &&
      (error.name === 'AuthSessionMissingError' ||
        (error as Error & { __isAuthError?: boolean }).__isAuthError === true ||
        /session.*missing|session_not_found/i.test((error as Error).message ?? ''));

    if (isSessionMissing) {
      return NextResponse.json(
        { success: false, error: '未登录', errorCode: 'UNAUTHENTICATED' },
        { status: 401 },
      );
    }

    // 认证链路异常按 500 处理，但不泄漏内部详情
    console.error('[learning/events] auth check failed:', error);
    return NextResponse.json(
      { success: false, error: '认证服务异常', errorCode: 'AUTH_CHECK_FAILED' },
      { status: 500 },
    );
  }

  // 无 user 返回 401
  if (!userId) {
    return NextResponse.json(
      { success: false, error: '未登录', errorCode: 'UNAUTHENTICATED' },
      { status: 401 },
    );
  }

  // 学习任务上下文：Gate 1B 不采集进度，完成身份校验后返回 pending。
  // 不回落到 course_assignments，preview 同样不写。
  if (taskId) {
    try {
      const { loadTaskSnapshot } = await import('@/lib/server/learning-tasks/snapshot-loader');
      const result = await loadTaskSnapshot(userId, taskId);

      if (!result.ok) {
        return NextResponse.json(
          { success: false, error: result.error, errorCode: result.errorCode },
          { status: result.status },
        );
      }

      return NextResponse.json({
        success: true,
        recorded: false,
        reason: 'task_event_collection_pending',
        actor: result.actor,
      });
    } catch (error: unknown) {
      console.error('[learning/events] task snapshot check failed:', error);
      return NextResponse.json(
        { success: false, error: '任务事件校验失败', errorCode: 'TASK_CHECK_FAILED' },
        { status: 500 },
      );
    }
  }

  // 请求体中的 studentId 完全忽略
  try {
    const resolution = await resolveLearningActor(userId, courseId);

    // preview 返回 200，不得写表
    if (resolution.ok && resolution.actor === 'preview') {
      return NextResponse.json({
        success: true,
        recorded: false,
        reason: 'preview',
        role: resolution.role,
      });
    }

    if (!resolution.ok) {
      const errorCode =
        resolution.reason === 'not_bound'
          ? 'LEARNER_NOT_BOUND'
          : resolution.reason === 'disabled'
            ? 'LEARNER_DISABLED'
            : 'COURSE_NOT_ASSIGNED';
      return NextResponse.json(
        { success: false, error: '无权写入学习事件', errorCode },
        { status: 403 },
      );
    }

    // learner 通过解析后才写事件
    const data = await recordLearningEvent(
      {
        courseId,
        eventType: eventType as LearningEventType,
        sceneId: typeof body.sceneId === 'string' ? body.sceneId : undefined,
        sceneOrder: typeof body.sceneOrder === 'number' ? body.sceneOrder : undefined,
        metadata:
          body.metadata && typeof body.metadata === 'object'
            ? (body.metadata as Record<string, unknown>)
            : undefined,
      },
      {
        studentId: resolution.studentId,
        assignmentId: resolution.assignmentId,
      },
    );

    return NextResponse.json({ success: true, recorded: true, data });
  } catch (error: unknown) {
    console.error('[learning/events] write failed:', error);
    return NextResponse.json(
      { success: false, error: '学习事件写入失败', errorCode: 'WRITE_FAILED' },
      { status: 500 },
    );
  }
}
