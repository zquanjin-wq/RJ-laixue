import { NextRequest, NextResponse } from 'next/server';
import { getErrorMessage, recordLearningEvent } from '@/lib/server/learning-mvp';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const courseId = typeof body.courseId === 'string' ? body.courseId : '';
    const eventType = typeof body.eventType === 'string' ? body.eventType : '';

    if (!courseId) {
      return NextResponse.json(
        { success: false, error: '缺少课程 ID' },
        { status: 400 },
      );
    }

    if (!['open_course', 'view_scene', 'complete_course'].includes(eventType)) {
      return NextResponse.json(
        { success: false, error: '无效的学习事件类型' },
        { status: 400 },
      );
    }

    const data = await recordLearningEvent({
      courseId,
      studentId: typeof body.studentId === 'string' ? body.studentId : undefined,
      eventType: eventType as 'open_course' | 'view_scene' | 'complete_course',
      sceneId: typeof body.sceneId === 'string' ? body.sceneId : undefined,
      sceneOrder: typeof body.sceneOrder === 'number' ? body.sceneOrder : undefined,
      metadata:
        body.metadata && typeof body.metadata === 'object'
          ? (body.metadata as Record<string, unknown>)
          : undefined,
    });

    return NextResponse.json({ success: true, data });
  } catch (error: unknown) {
    return NextResponse.json(
      { success: false, error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}
