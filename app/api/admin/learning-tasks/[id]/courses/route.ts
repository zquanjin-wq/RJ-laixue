import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth-context';
import { AccessRepository } from '@/lib/server/db/access-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

async function authorize(taskId: string) {
  const actor = await requireUser();
  const access = new AccessRepository(getDatabasePool());
  return { actor, access, allowed: await access.canManageTask(actor, taskId) };
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const taskId = (await params).id;
    const { allowed } = await authorize(taskId);
    if (!allowed) return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });
    const result = await getDatabasePool().query(
      `SELECT tc.course_id, tc.position, tc.is_required, tc.snapshot_id, c.title
       FROM app.task_courses tc JOIN app.courses c ON c.id = tc.course_id
       WHERE tc.task_id = $1 ORDER BY tc.position`, [taskId]);
    return NextResponse.json({ success: true, data: result.rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return NextResponse.json({ success: false, errorCode: message === 'Unauthenticated' ? 'UNAUTHENTICATED' : 'INTERNAL_ERROR' }, { status: message === 'Unauthenticated' ? 401 : 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const taskId = (await params).id;
    const { actor, access, allowed } = await authorize(taskId);
    if (!allowed) return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });
    const body = await request.json() as { courseIds?: unknown };
    const courseIds = [...new Set((Array.isArray(body.courseIds) ? body.courseIds : []).filter((value): value is string => typeof value === 'string' && value.length > 0))];
    if (!courseIds.length) return NextResponse.json({ success: false, errorCode: 'MISSING_COURSES' }, { status: 400 });
    for (const courseId of courseIds) if (!await access.canManageCourse(actor, courseId)) return NextResponse.json({ success: false, errorCode: 'COURSE_NOT_OWNED' }, { status: 403 });
    const database = getDatabasePool();
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const task = await client.query<{ status: string }>('SELECT status FROM app.learning_tasks WHERE id = $1 FOR UPDATE', [taskId]);
      if (!task.rowCount) return NextResponse.json({ success: false, errorCode: 'NOT_FOUND' }, { status: 404 });
      if (task.rows[0].status !== 'draft') return NextResponse.json({ success: false, errorCode: 'TASK_NOT_DRAFT' }, { status: 400 });
      await client.query('DELETE FROM app.task_courses WHERE task_id = $1', [taskId]);
      for (const [index, courseId] of courseIds.entries()) await client.query('INSERT INTO app.task_courses (task_id, course_id, position, is_required) VALUES ($1, $2, $3, true)', [taskId, courseId, index + 1]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return GET(request, { params: Promise.resolve({ id: taskId }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return NextResponse.json({ success: false, errorCode: message === 'Unauthenticated' ? 'UNAUTHENTICATED' : 'INTERNAL_ERROR' }, { status: message === 'Unauthenticated' ? 401 : 500 });
  }
}
