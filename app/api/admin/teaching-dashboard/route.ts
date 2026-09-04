import { NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { getDatabasePool } from '@/lib/server/db/pool';

type TaskRow = {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
  created_at: string;
};

type AssignmentRow = {
  status: string;
  effective_seconds: number | string;
};

export async function GET() {
  const actor = await getCurrentActor();
  if (!actor)
    return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  if (actor.role === 'learner')
    return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });

  const ownerUserId = actor.role === 'teacher' ? actor.userId : null;
  const pool = getDatabasePool();
  const [tasksResult, coursesResult, assignmentsResult] = await Promise.all([
    pool.query<TaskRow>(
      `SELECT id::text, title, status, due_at::text, created_at::text
         FROM app.learning_tasks
        WHERE ($1::text IS NULL OR created_by = $1)
        ORDER BY created_at DESC`,
      [ownerUserId],
    ),
    pool.query<{ count: number | string }>(
      `SELECT count(*) AS count
         FROM app.courses
        WHERE deleted_at IS NULL
          AND ($1::text IS NULL OR owner_user_id = $1)`,
      [ownerUserId],
    ),
    pool.query<AssignmentRow>(
      `SELECT assignment.status, assignment.effective_seconds
         FROM app.task_assignments assignment
         JOIN app.learning_tasks task ON task.id = assignment.task_id
        WHERE ($1::text IS NULL OR task.created_by = $1)`,
      [ownerUserId],
    ),
  ]);

  const tasks = tasksResult.rows;
  const assignments = assignmentsResult.rows;
  const now = Date.now();
  const dueSoon = tasks.filter((task) => {
    if (task.status !== 'published' || !task.due_at) return false;
    const due = new Date(task.due_at).getTime();
    return due >= now && due - now <= 7 * 24 * 60 * 60 * 1000;
  });

  return NextResponse.json({
    success: true,
    data: {
      courseCount: Number(coursesResult.rows[0]?.count ?? 0),
      taskCount: tasks.length,
      activeTaskCount: tasks.filter((task) => task.status === 'published').length,
      learnerCount: assignments.length,
      startedCount: assignments.filter((assignment) => assignment.status !== 'not_started').length,
      completedCount: assignments.filter((assignment) => assignment.status === 'completed').length,
      effectiveSeconds: assignments.reduce(
        (sum, assignment) => sum + Number(assignment.effective_seconds ?? 0),
        0,
      ),
      dueSoon: dueSoon.slice(0, 5),
      recentTasks: tasks.slice(0, 5),
    },
  });
}
