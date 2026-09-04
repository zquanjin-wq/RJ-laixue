import { NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { getDatabasePool } from '@/lib/server/db/pool';

type CourseRow = { id: string; title: string; updatedAt: string };
type ProgressRow = { courseId: string; taskId: string; userId: string; status: string; effectiveSeconds: number };

export async function GET() {
  const actor = await getCurrentActor();
  if (!actor) return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  if (actor.role === 'learner') return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });

  const pool = getDatabasePool();
  const courseResult = await pool.query<CourseRow>(
    `SELECT id, title, updated_at::text AS "updatedAt" FROM app.courses WHERE deleted_at IS NULL AND ($1 = 'admin' OR owner_user_id = $2) ORDER BY updated_at DESC`,
    [actor.role, actor.userId],
  );
  const courses = courseResult.rows;
  const courseIds = courses.map((course) => course.id);
  const progress = courseIds.length ? (await pool.query<ProgressRow>(
    `SELECT course_id AS "courseId", task_id::text AS "taskId", user_id AS "userId", status, effective_seconds::double precision AS "effectiveSeconds" FROM app.task_course_progress WHERE course_id = ANY($1::text[])`,
    [courseIds],
  )).rows : [];
  const rows = courses.map((course) => {
    const items = progress.filter((item) => item.courseId === course.id);
    const learners = new Set(items.map((item) => item.userId));
    const completed = new Set(items.filter((item) => item.status === 'completed').map((item) => item.userId));
    const tasks = new Set(items.map((item) => item.taskId));
    return { courseId: course.id, title: course.title || 'Untitled course', updatedAt: course.updatedAt, taskCount: tasks.size, learnerCount: learners.size, completedCount: completed.size, completionRate: learners.size ? Math.round((completed.size / learners.size) * 100) : 0, effectiveSeconds: items.reduce((sum, item) => sum + Number(item.effectiveSeconds ?? 0), 0) };
  });
  return NextResponse.json({ success: true, data: { overview: { courseCount: rows.length, taskCount: rows.reduce((sum, row) => sum + row.taskCount, 0), learnerCount: rows.reduce((sum, row) => sum + row.learnerCount, 0), effectiveSeconds: rows.reduce((sum, row) => sum + row.effectiveSeconds, 0) }, courses: rows } });
}
