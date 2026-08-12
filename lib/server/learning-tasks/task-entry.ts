/**
 * Resolves a published task's share token for the learner entry page.
 */
import { getServiceSupabase } from '@/lib/supabase/server';
import { checkTaskEntryPermission, resolveActor } from './permissions';

export type TaskEntryResult =
  | {
      ok: true;
      taskId: string;
      courseId: string;
      courses?: Array<{ courseId: string; title: string | null; position: number }>;
      title: string | null;
      actor: 'learner' | 'preview';
      status: 'enterable' | 'not_started_yet';
    }
  | { ok: false; error: string; errorCode: string; status: number };

export async function resolveTaskEntry(userId: string, token: string): Promise<TaskEntryResult> {
  const svc = getServiceSupabase();
  const { data: task, error } = await svc
    .from('learning_tasks')
    .select('id, course_id, title, status, start_at, due_at, snapshot_id, created_by')
    .eq('share_token', token)
    .maybeSingle();

  if (error)
    return { ok: false, error: '查询任务失败。', errorCode: 'INTERNAL_ERROR', status: 500 };
  if (!task || task.status !== 'published') {
    return { ok: false, error: '任务不存在。', errorCode: 'TASK_NOT_FOUND', status: 404 };
  }

  const { data: taskCourses } = await svc
    .from('task_courses')
    .select('course_id, position')
    .eq('task_id', task.id)
    .order('position');
  const courseIds = (taskCourses ?? []).map((item) => item.course_id);
  const { data: courseRows } = courseIds.length
    ? await svc.from('courses').select('id, title').in('id', courseIds)
    : { data: [] };
  const titles = new Map((courseRows ?? []).map((course) => [course.id, course.title]));
  const courses = (taskCourses ?? []).map((item) => ({
    courseId: item.course_id,
    title: titles.get(item.course_id) ?? null,
    position: item.position,
  }));

  const permission = await checkTaskEntryPermission(userId, task.id);
  if (!permission.ok) {
    const actor = await resolveActor(userId);
    const errorCode =
      actor.role === 'teacher'
        ? 'TASK_NOT_OWNED'
        : permission.reason === 'learner_not_bound'
          ? 'LEARNER_NOT_BOUND'
          : permission.reason === 'learner_disabled'
            ? 'LEARNER_DISABLED'
            : 'LEARNER_NOT_ASSIGNED';
    return { ok: false, error: '无权进入此学习任务。', errorCode, status: 403 };
  }

  if (permission.actor === 'preview') {
    return {
      ok: true,
      taskId: task.id,
      courseId: task.course_id,
      courses,
      title: task.title,
      actor: 'preview',
      status: 'enterable',
    };
  }

  if (task.start_at && new Date(task.start_at) > new Date()) {
    return {
      ok: true,
      taskId: task.id,
      courseId: task.course_id,
      courses,
      title: task.title,
      actor: 'learner',
      status: 'not_started_yet',
    };
  }

  return {
    ok: true,
    taskId: task.id,
    courseId: task.course_id,
    courses,
    title: task.title,
    actor: 'learner',
    status: 'enterable',
  };
}
