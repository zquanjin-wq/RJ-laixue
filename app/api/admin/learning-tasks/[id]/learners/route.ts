import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth-context';
import { AccessRepository } from '@/lib/server/db/access-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const taskId = (await params).id;
    const actor = await requireUser();
    if (!await new AccessRepository(getDatabasePool()).canManageTask(actor, taskId)) return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });
    const body = await request.json() as { learnerIds?: unknown };
    const learnerIds = [...new Set((Array.isArray(body.learnerIds) ? body.learnerIds : []).filter((value): value is string => typeof value === 'string' && value.length > 0))];
    if (!learnerIds.length) return NextResponse.json({ success: false, errorCode: 'INVALID_LEARNERS' }, { status: 400 });
    const database = getDatabasePool();
    const learners = await database.query<{ id: string }>(`SELECT u.id FROM public."user" u JOIN app.user_profiles p ON p.user_id = u.id WHERE p.role = 'learner' AND u.banned IS NOT TRUE AND u.id = ANY($1::text[])`, [learnerIds]);
    if (learners.rowCount !== learnerIds.length) return NextResponse.json({ success: false, errorCode: 'INVALID_LEARNERS' }, { status: 400 });
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const task = await client.query<{ status: string }>('SELECT status FROM app.learning_tasks WHERE id = $1 FOR UPDATE', [taskId]);
      if (!task.rowCount) return NextResponse.json({ success: false, errorCode: 'NOT_FOUND' }, { status: 404 });
      if (task.rows[0].status === 'draft') { await client.query('DELETE FROM app.task_assignments WHERE task_id = $1', [taskId]); }
      else if (task.rows[0].status !== 'published') return NextResponse.json({ success: false, errorCode: 'TASK_NOT_DRAFT' }, { status: 400 });
      for (const learnerId of learnerIds) await client.query('INSERT INTO app.task_assignments (task_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [taskId, learnerId]);
      if (task.rows[0].status === 'published') await client.query(`INSERT INTO app.task_course_progress (task_id, user_id, course_id) SELECT $1, assignment.user_id, course.course_id FROM app.task_assignments assignment CROSS JOIN app.task_courses course WHERE assignment.task_id = $1 AND course.task_id = $1 ON CONFLICT DO NOTHING`, [taskId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    const result = await database.query('SELECT id, user_id AS student_id, status, assigned_at FROM app.task_assignments WHERE task_id = $1 ORDER BY assigned_at', [taskId]);
    return NextResponse.json({ success: true, data: result.rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return NextResponse.json({ success: false, errorCode: message === 'Unauthenticated' ? 'UNAUTHENTICATED' : 'INTERNAL_ERROR' }, { status: message === 'Unauthenticated' ? 401 : 500 });
  }
}
