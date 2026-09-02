import { NextRequest, NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { CourseRepository, type CourseRecord } from '@/lib/server/db/course-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export const runtime = 'nodejs';
export const maxDuration = 300;

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
    author_name: null,
  };
}

export async function GET(request: NextRequest) {
  try {
    const actor = await getCurrentActor();
    if (!actor) {
      return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED' }, { status: 401 });
    }

    const scope = request.nextUrl.searchParams.get('scope') ?? 'mine';
    if (scope === 'all' && actor.role !== 'admin') {
      return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });
    }

    const courses = new CourseRepository(getDatabasePool());
    const rows =
      scope === 'all' ? await courses.listCourses() : await courses.listOwnedCourses(actor.userId);
    return NextResponse.json({ success: true, data: rows.map(courseResponse) });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to list courses' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await getCurrentActor();
    if (!actor) {
      return NextResponse.json(
        { success: false, errorCode: 'UNAUTHENTICATED', error: '请先登录后再保存课程' },
        { status: 401 },
      );
    }
    if (actor.role === 'learner') {
      return NextResponse.json(
        { success: false, errorCode: 'FORBIDDEN', error: '学员不能保存课程' },
        { status: 403 },
      );
    }

    const body = (await request.json()) as {
      id?: string;
      title?: string;
      topic?: string;
      data?: { stage?: { name?: string }; outlines?: unknown[]; scenes?: unknown[] };
      saveState?: string;
    };
    if (!body.id || !body.data?.stage) {
      return NextResponse.json({ success: false, error: '缺少课程数据' }, { status: 400 });
    }

    const content = {
      stage: body.data.stage,
      scenes: Array.isArray(body.data.scenes) ? body.data.scenes : [],
      outlines: Array.isArray(body.data.outlines) ? body.data.outlines : [],
      saveState: body.saveState === 'draft' ? 'draft' : 'ready',
      audioGeneration: {
        attempted: false,
        skipped: true,
        reason: 'save_only_no_tts_generation',
        updatedAt: new Date().toISOString(),
      },
    };
    const title = body.title || body.data.stage.name || '';
    const saveState = body.saveState === 'draft' ? 'draft' : 'ready';
    const courses = new CourseRepository(getDatabasePool());
    const existing = await courses.getCourse(body.id);

    if (!existing) {
      const created = await courses.createCourse({
        id: body.id,
        ownerUserId: actor.userId,
        title,
        topic: body.topic ?? '',
        content,
        saveState,
      });
      return NextResponse.json({
        success: true,
        data: { id: created.id, audioGeneration: content.audioGeneration },
      });
    }
    if (existing.ownerUserId !== actor.userId && actor.role !== 'admin') {
      return NextResponse.json(
        { success: false, errorCode: 'FORBIDDEN', error: '您没有权限保存此课程。' },
        { status: 403 },
      );
    }

    const updated = await courses.updateCourse({
      id: existing.id,
      ownerUserId: existing.ownerUserId,
      expectedRevision: existing.contentRevision,
      title,
      topic: body.topic ?? '',
      content,
      saveState,
    });
    if (!updated) {
      return NextResponse.json(
        { success: false, errorCode: 'CONFLICT', error: '课程刚被其他保存操作更新，请重试。' },
        { status: 409 },
      );
    }
    return NextResponse.json({
      success: true,
      data: { id: updated.id, audioGeneration: content.audioGeneration },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to save course' },
      { status: 500 },
    );
  }
}
