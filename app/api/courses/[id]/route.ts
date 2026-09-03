import { NextRequest, NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { CourseRepository, type CourseRecord } from '@/lib/server/db/course-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

function courseResponse(course: CourseRecord) {
  return {
    id: course.id,
    title: course.title,
    topic: course.topic,
    data: course.content,
    save_state: course.saveState,
    content_revision: course.contentRevision,
    created_by: course.ownerUserId,
    created_at: course.createdAt,
    updated_at: course.updatedAt,
  };
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getCurrentActor();
    if (!actor) {
      return NextResponse.json(
        { success: false, errorCode: 'UNAUTHENTICATED', error: '请先登录后再访问课程。' },
        { status: 401 },
      );
    }
    const { id } = await params;
    const course = await new CourseRepository(getDatabasePool()).getCourse(id);
    if (!course) {
      return NextResponse.json(
        { success: false, errorCode: 'NOT_FOUND', error: '课程不存在' },
        { status: 404 },
      );
    }
    if (actor.role === 'teacher' && course.ownerUserId !== actor.userId) {
      return NextResponse.json(
        { success: false, errorCode: 'NOT_FOUND', error: '课程不存在' },
        { status: 404 },
      );
    }
    const shared = new URL(_request.url).searchParams.get('share') === '1';
    if (actor.role === 'learner' && !shared) {
      return NextResponse.json(
        { success: false, errorCode: 'FORBIDDEN', error: '课程学习授权将在学习任务切片接入。' },
        { status: 403 },
      );
    }
    return NextResponse.json({ success: true, data: courseResponse(course) });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '读取课程失败' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await getCurrentActor();
    if (!actor) {
      return NextResponse.json(
        { success: false, errorCode: 'UNAUTHENTICATED', error: '请先登录后再删除课程' },
        { status: 401 },
      );
    }
    const { id } = await params;
    const courses = new CourseRepository(getDatabasePool());
    const course = await courses.getCourse(id);
    if (!course) {
      return NextResponse.json(
        { success: false, errorCode: 'NOT_FOUND', error: '课程不存在' },
        { status: 404 },
      );
    }
    if (course.ownerUserId !== actor.userId && actor.role !== 'admin') {
      return NextResponse.json(
        { success: false, errorCode: 'FORBIDDEN', error: '只有课程创建者才能删除' },
        { status: 403 },
      );
    }
    const deleted = await courses.softDeleteCourse(id, course.ownerUserId);
    if (!deleted) {
      return NextResponse.json({ success: false, error: '课程删除失败' }, { status: 409 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '删除课程失败' },
      { status: 500 },
    );
  }
}
