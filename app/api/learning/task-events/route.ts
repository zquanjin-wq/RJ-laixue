import { NextRequest, NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { recordTaskLearningEvent, type TaskLearningEventType } from '@/lib/server/task-learning';

const EVENT_TYPES: TaskLearningEventType[] = [
  'task_opened',
  'scene_started',
  'scene_completed',
  'heartbeat',
  'question_asked',
  'check_submitted',
  'check_reviewed',
  'task_completed',
];

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ success: false, error: '请求格式错误' }, { status: 400 });
  const taskId = typeof body.taskId === 'string' ? body.taskId : '';
  const courseId = typeof body.courseId === 'string' ? body.courseId : '';
  const eventType = typeof body.eventType === 'string' ? body.eventType : '';
  const clientEventId = typeof body.clientEventId === 'string' ? body.clientEventId : '';
  if (
    !taskId ||
    !courseId ||
    !clientEventId ||
    !EVENT_TYPES.includes(eventType as TaskLearningEventType)
  ) {
    return NextResponse.json({ success: false, error: '学习事件参数不完整' }, { status: 400 });
  }

  const actor = await getCurrentActor();
  if (!actor) return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED' }, { status: 401 });

  try {
    const result = await recordTaskLearningEvent(actor.userId, {
      taskId,
      courseId,
      eventType: eventType as TaskLearningEventType,
      clientEventId,
      sceneId: typeof body.sceneId === 'string' ? body.sceneId : undefined,
      sceneOrder: typeof body.sceneOrder === 'number' ? body.sceneOrder : undefined,
      metadata:
        body.metadata && typeof body.metadata === 'object'
          ? (body.metadata as Record<string, unknown>)
          : undefined,
    });
    if (!result.ok)
      return NextResponse.json(
        { success: false, error: result.error, errorCode: result.errorCode },
        { status: result.status },
      );
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error('[learning/task-events] write failed', error);
    return NextResponse.json(
      { success: false, error: '学习事件写入失败', errorCode: 'WRITE_FAILED' },
      { status: 500 },
    );
  }
}
