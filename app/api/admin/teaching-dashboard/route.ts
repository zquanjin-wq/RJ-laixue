import { NextResponse } from 'next/server';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { resolveActor } from '@/lib/server/learning-tasks/permissions';

export async function GET() {
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();
  if (!user)
    return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED' }, { status: 401 });

  const actor = await resolveActor(user.id);
  if (actor.role === 'learner')
    return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });

  const svc = getServiceSupabase();
  let tasksQuery = svc
    .from('learning_tasks')
    .select('id, title, status, due_at, course_id, created_at')
    .order('created_at', { ascending: false });
  let coursesQuery = svc.from('courses').select('id', { count: 'exact', head: true });
  if (actor.role === 'teacher') {
    tasksQuery = tasksQuery.eq('created_by', user.id);
    coursesQuery = coursesQuery.eq('created_by', user.id);
  }

  const [{ data: tasks, error: tasksError }, coursesResult] = await Promise.all([
    tasksQuery,
    coursesQuery,
  ]);
  if (tasksError) throw tasksError;
  const taskRows = tasks ?? [];
  const taskIds = taskRows.map((task) => task.id);
  const { data: learners } = taskIds.length
    ? await svc
        .from('task_learners')
        .select('task_id, status, progress_percent, effective_seconds, last_seen_at')
        .in('task_id', taskIds)
    : { data: [] };
  const learnerRows = learners ?? [];
  const now = Date.now();
  const dueSoon = taskRows.filter((task) => {
    if (task.status !== 'published' || !task.due_at) return false;
    const due = new Date(task.due_at).getTime();
    return due >= now && due - now <= 7 * 24 * 60 * 60 * 1000;
  });

  return NextResponse.json({
    success: true,
    data: {
      courseCount: coursesResult.count ?? 0,
      taskCount: taskRows.length,
      activeTaskCount: taskRows.filter((task) => task.status === 'published').length,
      learnerCount: learnerRows.length,
      startedCount: learnerRows.filter((learner) => learner.status !== 'not_started').length,
      completedCount: learnerRows.filter((learner) => learner.status === 'completed').length,
      effectiveSeconds: learnerRows.reduce(
        (sum, learner) => sum + Number(learner.effective_seconds ?? 0),
        0,
      ),
      dueSoon: dueSoon.slice(0, 5),
      recentTasks: taskRows.slice(0, 5),
    },
  });
}
