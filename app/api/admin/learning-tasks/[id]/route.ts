import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth-context';
import { AccessRepository } from '@/lib/server/db/access-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

async function canManage(taskId: string) {
  const actor = await requireUser();
  const allowed = await new AccessRepository(getDatabasePool()).canManageTask(actor, taskId);
  return { actor, allowed };
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const taskId = (await params).id;
    const { allowed } = await canManage(taskId);
    if (!allowed) return NextResponse.json({ success: false, errorCode: 'FORBIDDEN', error: '无权查看此任务。' }, { status: 403 });
    const database = getDatabasePool();
    const task = await database.query(
      `SELECT id, title, description, status, task_type, start_at, due_at, share_token, published_at, created_by, created_at, updated_at, source_task_id, completion_rule
       FROM app.learning_tasks WHERE id = $1`, [taskId],
    );
    if (!task.rowCount) return NextResponse.json({ success: false, errorCode: 'TASK_NOT_FOUND', error: '任务不存在。' }, { status: 404 });
    const [courses, learners] = await Promise.all([
      database.query(
        `SELECT tc.course_id, tc.position, tc.is_required, tc.snapshot_id, c.title
         FROM app.task_courses tc JOIN app.courses c ON c.id = tc.course_id
         WHERE tc.task_id = $1 ORDER BY tc.position`, [taskId]),
      database.query(
        `SELECT a.id, a.user_id AS student_id, a.status, a.progress_percent::float, a.completed_scene_count, a.total_scene_count, a.assigned_at,
                p.display_name AS name, u.email
         FROM app.task_assignments a JOIN app.user_profiles p ON p.user_id = a.user_id JOIN public."user" u ON u.id = a.user_id
         WHERE a.task_id = $1 ORDER BY a.assigned_at`, [taskId]),
    ]);
    return NextResponse.json({ success: true, data: { ...task.rows[0], course_id: courses.rows[0]?.course_id ?? null, snapshot_id: courses.rows[0]?.snapshot_id ?? null, courses: courses.rows, learners: learners.rows } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return NextResponse.json({ success: false, errorCode: message === 'Unauthenticated' ? 'UNAUTHENTICATED' : 'INTERNAL_ERROR', error: message === 'Unauthenticated' ? '请先登录。' : '获取任务详情失败。' }, { status: message === 'Unauthenticated' ? 401 : 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const taskId = (await params).id;
    const { allowed } = await canManage(taskId);
    if (!allowed) return NextResponse.json({ success: false, errorCode: 'FORBIDDEN', error: '无权修改此任务。' }, { status: 403 });
    const body = await request.json() as Record<string, unknown>;
    const title = typeof body.title === 'string' ? body.title.trim() : null;
    const description = typeof body.description === 'string' ? body.description : null;
    const startAt = typeof body.startAt === 'string' && body.startAt ? new Date(body.startAt) : null;
    const dueAt = typeof body.dueAt === 'string' && body.dueAt ? new Date(body.dueAt) : null;
    if ((startAt && Number.isNaN(startAt.getTime())) || (dueAt && Number.isNaN(dueAt.getTime()))) return NextResponse.json({ success: false, errorCode: 'INVALID_TIME_RANGE', error: '任务时间无效。' }, { status: 400 });
    const result = await getDatabasePool().query(
      `UPDATE app.learning_tasks SET title = COALESCE($2, title), description = COALESCE($3, description), start_at = CASE WHEN $4::timestamptz IS NULL THEN start_at ELSE $4 END, due_at = CASE WHEN $5::timestamptz IS NULL THEN due_at ELSE $5 END, updated_at = now()
       WHERE id = $1 AND status = 'draft' RETURNING id, title, description, status, start_at, due_at`,
      [taskId, title, description, startAt, dueAt],
    );
    if (!result.rowCount) return NextResponse.json({ success: false, errorCode: 'TASK_NOT_DRAFT', error: '只能修改草稿任务。' }, { status: 400 });
    return NextResponse.json({ success: true, data: result.rows[0] });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return NextResponse.json({ success: false, errorCode: message === 'Unauthenticated' ? 'UNAUTHENTICATED' : 'INTERNAL_ERROR', error: message === 'Unauthenticated' ? '请先登录。' : '更新任务失败。' }, { status: message === 'Unauthenticated' ? 401 : 500 });
  }
}
