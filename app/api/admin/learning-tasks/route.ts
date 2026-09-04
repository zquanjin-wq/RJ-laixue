import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth-context';
import { AccessRepository } from '@/lib/server/db/access-repository';
import { getDatabasePool } from '@/lib/server/db/pool';
import { TaskRepository } from '@/lib/server/db/task-repository';

export async function POST(request: Request) {
  try {
    const actor = await requireUser();
    if (actor.role === 'learner') {
      return NextResponse.json({ success: false, errorCode: 'FORBIDDEN', error: '无权创建学习任务。' }, { status: 403 });
    }
    const body = await request.json() as Record<string, unknown>;
    const courseIds = [...new Set((Array.isArray(body.courseIds) ? body.courseIds : [body.courseId]).filter((value): value is string => typeof value === 'string' && value.length > 0))];
    const learnerIds = [...new Set((Array.isArray(body.learnerIds) ? body.learnerIds : []).filter((value): value is string => typeof value === 'string' && value.length > 0))];
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : null;
    if (!title || courseIds.length === 0 || learnerIds.length === 0) {
      return NextResponse.json({ success: false, errorCode: 'MISSING_FIELDS', error: '请填写任务名称，并至少选择一个课件和学员。' }, { status: 400 });
    }
    const access = new AccessRepository(getDatabasePool());
    for (const courseId of courseIds) {
      if (!await access.canManageCourse(actor, courseId)) {
        return NextResponse.json({ success: false, errorCode: 'COURSE_NOT_OWNED', error: '无权使用所选课件。' }, { status: 403 });
      }
    }
    const validLearners = await getDatabasePool().query<{ id: string }>(
      `SELECT u.id FROM public."user" u JOIN app.user_profiles p ON p.user_id = u.id
       WHERE p.role = 'learner' AND u.banned IS NOT TRUE AND u.id = ANY($1::text[])`,
      [learnerIds],
    );
    if (validLearners.rowCount !== learnerIds.length) {
      return NextResponse.json({ success: false, errorCode: 'INVALID_LEARNERS', error: '包含不存在或已禁用的学员。' }, { status: 400 });
    }
    const startAt = typeof body.startAt === 'string' && body.startAt ? new Date(body.startAt) : null;
    const dueAt = typeof body.dueAt === 'string' && body.dueAt ? new Date(body.dueAt) : null;
    if ((startAt && Number.isNaN(startAt.getTime())) || (dueAt && Number.isNaN(dueAt.getTime()))) {
      return NextResponse.json({ success: false, errorCode: 'INVALID_TIME_RANGE', error: '任务时间无效。' }, { status: 400 });
    }
    const taskId = await new TaskRepository(getDatabasePool()).createTask({
      title,
      description,
      createdBy: actor.userId,
      taskType: body.taskType === 'remedial' ? 'remedial' : 'normal',
      sourceTaskId: typeof body.sourceTaskId === 'string' ? body.sourceTaskId : null,
      startAt,
      dueAt,
      courses: courseIds.map((courseId) => ({ courseId })),
      userIds: learnerIds,
    });
    return NextResponse.json({ success: true, data: { id: taskId } }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'Unauthenticated') return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED', error: '请先登录。' }, { status: 401 });
    console.error('[admin/learning-tasks] create failed', error);
    return NextResponse.json({ success: false, errorCode: 'INTERNAL_ERROR', error: '创建学习任务失败。' }, { status: 500 });
  }
}
