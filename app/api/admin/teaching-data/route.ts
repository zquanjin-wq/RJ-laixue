import { NextRequest, NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { getDatabasePool } from '@/lib/server/db/pool';
import { learnerDisplayStatus } from '@/lib/server/learning-tasks/report';

type TaskRow = {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
};

type LearnerRow = {
  task_id: string;
  student_id: string;
  student_name: string;
  status: 'not_started' | 'in_progress' | 'completed';
  progress_percent: number | string;
  mastery_percent: number | string | null;
  effective_seconds: number | string;
  last_seen_at: string | null;
};

type TaskCourseCount = { task_id: string; course_count: number | string };

export async function GET(request: NextRequest) {
  const actor = await getCurrentActor();
  if (!actor)
    return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  if (actor.role === 'learner')
    return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });

  const taskId = request.nextUrl.searchParams.get('taskId') || null;
  const status = request.nextUrl.searchParams.get('status') || 'published';
  const ownerUserId = actor.role === 'teacher' ? actor.userId : null;
  const pool = getDatabasePool();
  const tasksResult = await pool.query<TaskRow>(
    `SELECT id::text, title, status, due_at::text
       FROM app.learning_tasks
      WHERE ($1::text IS NULL OR created_by = $1)
        AND ($2::text IS NULL OR id::text = $2)
        AND ($3::text = 'all' OR status = $3)
      ORDER BY created_at DESC`,
    [ownerUserId, taskId, status],
  );
  const tasks = tasksResult.rows;
  const taskIds = tasks.map((task) => task.id);
  const [learnersResult, courseCountsResult] = taskIds.length
    ? await Promise.all([
        pool.query<LearnerRow>(
          `SELECT assignment.task_id::text, assignment.user_id AS student_id,
                  COALESCE(profile.display_name, account.name) AS student_name,
                  assignment.status, assignment.progress_percent,
                  assignment.mastery_percent, assignment.effective_seconds,
                  assignment.last_seen_at::text
             FROM app.task_assignments assignment
             JOIN public."user" account ON account.id = assignment.user_id
             LEFT JOIN app.user_profiles profile ON profile.user_id = assignment.user_id
            WHERE assignment.task_id = ANY($1::uuid[])`,
          [taskIds],
        ),
        pool.query<TaskCourseCount>(
          `SELECT task_id::text, count(*) AS course_count
             FROM app.task_courses
            WHERE task_id = ANY($1::uuid[])
            GROUP BY task_id`,
          [taskIds],
        ),
      ])
    : [{ rows: [] as LearnerRow[] }, { rows: [] as TaskCourseCount[] }];

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const courseCountByTask = new Map(
    courseCountsResult.rows.map((row) => [row.task_id, Number(row.course_count)]),
  );
  const learners = learnersResult.rows.map((row) => {
    const task = taskById.get(row.task_id);
    const status = learnerDisplayStatus({ status: row.status }, task?.due_at ?? null);
    return {
      taskId: row.task_id,
      taskTitle: task?.title || '未命名任务',
      studentId: row.student_id,
      studentName: row.student_name || '未命名学员',
      status,
      progressPercent: Number(row.progress_percent ?? 0),
      masteryPercent: row.mastery_percent == null ? null : Number(row.mastery_percent),
      effectiveSeconds: Number(row.effective_seconds ?? 0),
      lastSeenAt: row.last_seen_at,
    };
  });
  const total = learners.length;
  const started = learners.filter(
    (learner) => learner.status !== 'not_started' && learner.status !== 'overdue',
  ).length;
  const completed = learners.filter((learner) => learner.status === 'completed').length;
  const overdue = learners.filter((learner) => learner.status === 'overdue').length;
  const effectiveSeconds = learners.reduce((sum, learner) => sum + learner.effectiveSeconds, 0);
  const needsAttention = learners
    .filter((learner) => learner.status === 'not_started' || learner.status === 'overdue')
    .sort((left, right) => Number(left.status === 'overdue') - Number(right.status === 'overdue'))
    .slice(0, 12);

  const taskSummary = tasks.map((task) => {
    const taskLearners = learners.filter((learner) => learner.taskId === task.id);
    const taskCompleted = taskLearners.filter((learner) => learner.status === 'completed').length;
    return {
      id: task.id,
      title: task.title || '未命名任务',
      status: task.status,
      dueAt: task.due_at,
      learnerCount: taskLearners.length,
      completedCount: taskCompleted,
      completionRate: taskLearners.length
        ? Math.round((taskCompleted / taskLearners.length) * 100)
        : 0,
      courseCount: courseCountByTask.get(task.id) ?? 0,
      overdueCount: taskLearners.filter((learner) => learner.status === 'overdue').length,
      notStartedCount: taskLearners.filter((learner) => learner.status === 'not_started').length,
    };
  });

  return NextResponse.json({
    success: true,
    data: {
      overview: {
        total,
        started,
        completed,
        overdue,
        effectiveSeconds,
        startRate: total ? Math.round((started / total) * 100) : 0,
        completionRate: total ? Math.round((completed / total) * 100) : 0,
      },
      tasks: taskSummary,
      needsAttention,
    },
  });
}
