import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { resolveActor } from '@/lib/server/learning-tasks/permissions';
import { learnerDisplayStatus } from '@/lib/server/learning-tasks/report';

type TaskRow = {
  id: string;
  title: string | null;
  status: string;
  due_at: string | null;
  created_by: string;
  created_at: string;
};

export async function GET(request: NextRequest) {
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();
  if (!user)
    return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED' }, { status: 401 });

  const actor = await resolveActor(user.id);
  if (actor.role === 'learner')
    return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });

  const taskId = request.nextUrl.searchParams.get('taskId') || undefined;
  const status = request.nextUrl.searchParams.get('status') || 'published';
  const svc = getServiceSupabase();
  let taskQuery = svc
    .from('learning_tasks')
    .select('id, title, status, due_at, created_by, created_at')
    .order('created_at', { ascending: false });
  if (actor.role === 'teacher') taskQuery = taskQuery.eq('created_by', user.id);
  if (taskId) taskQuery = taskQuery.eq('id', taskId);
  if (status !== 'all') taskQuery = taskQuery.eq('status', status);

  const { data: rawTasks, error } = await taskQuery;
  if (error) throw error;
  const tasks = (rawTasks ?? []) as TaskRow[];
  const taskIds = tasks.map((task) => task.id);
  const { data: learnerRows } = taskIds.length
    ? await svc
        .from('task_learners')
        .select(
          'task_id, student_id, status, progress_percent, mastery_percent, effective_seconds, last_seen_at',
        )
        .in('task_id', taskIds)
    : { data: [] };
  const { data: taskCourses } = taskIds.length
    ? await svc.from('task_courses').select('task_id, course_id').in('task_id', taskIds)
    : { data: [] };
  const studentIds = [...new Set((learnerRows ?? []).map((row) => row.student_id))];
  const { data: students } = studentIds.length
    ? await svc.from('students').select('id, name').in('id', studentIds)
    : { data: [] };
  const nameById = new Map((students ?? []).map((student) => [student.id, student.name]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  const learners = (learnerRows ?? []).map((row) => {
    const task = taskById.get(row.task_id);
    const displayStatus = learnerDisplayStatus(
      {
        status:
          row.status === 'completed' || row.status === 'in_progress' ? row.status : 'not_started',
      },
      task?.due_at ?? null,
    );
    return {
      taskId: row.task_id,
      taskTitle: task?.title || '未命名任务',
      studentId: row.student_id,
      studentName: nameById.get(row.student_id) || '未命名学员',
      status: displayStatus,
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
    .sort((a, b) => Number(a.status === 'overdue') - Number(b.status === 'overdue'))
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
      courseCount: (taskCourses ?? []).filter((item) => item.task_id === task.id).length || 1,
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
