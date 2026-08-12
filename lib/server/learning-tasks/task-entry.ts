/**
 * 任务入口解析（Gate 1B）
 *
 * 根据 share_token 解析登录用户的任务入口状态。
 * 在服务端执行，供 /learn/[token] RSC 使用。
 */
import { getServiceSupabase } from '@/lib/supabase/server';
import { resolveActor } from './permissions';

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

  if (error) {
    return { ok: false, error: '查询任务失败', errorCode: 'INTERNAL_ERROR', status: 500 };
  }
  if (!task) {
    return { ok: false, error: '任务不存在', errorCode: 'TASK_NOT_FOUND', status: 404 };
  }

  const { data: taskCourses } = await svc
    .from('task_courses')
    .select('course_id, position')
    .eq('task_id', task.id)
    .order('position');
  const packageCourseIds = (taskCourses ?? []).map((item) => item.course_id);
  const { data: courseRows } = packageCourseIds.length
    ? await svc.from('courses').select('id, title').in('id', packageCourseIds)
    : { data: [] };
  const titles = new Map((courseRows ?? []).map((course) => [course.id, course.title]));
  const courses = (taskCourses ?? []).map((item) => ({
    courseId: item.course_id,
    title: titles.get(item.course_id) ?? null,
    position: item.position,
  }));

  if (task.status !== 'published') {
    return { ok: false, error: '任务不存在或未发布', errorCode: 'TASK_NOT_FOUND', status: 404 };
  }

  const actor = await resolveActor(userId);

  if (actor.role === 'admin') {
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

  if (actor.role === 'teacher') {
    if (task.created_by !== userId) {
      return { ok: false, error: '无权进入此学习任务', errorCode: 'TASK_NOT_OWNED', status: 403 };
    }
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

  // learner
  const { data: student, error: studentError } = await svc
    .from('students')
    .select('id, disabled_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (studentError) {
    return { ok: false, error: '查询学员失败', errorCode: 'INTERNAL_ERROR', status: 500 };
  }
  if (!student) {
    return { ok: false, error: '账号未绑定学员', errorCode: 'LEARNER_NOT_BOUND', status: 403 };
  }
  if (student.disabled_at) {
    return { ok: false, error: '学员账号已停用', errorCode: 'LEARNER_DISABLED', status: 403 };
  }

  const { data: taskLearner, error: tlError } = await svc
    .from('task_learners')
    .select('id')
    .eq('task_id', task.id)
    .eq('student_id', student.id)
    .maybeSingle();

  if (tlError) {
    return { ok: false, error: '查询学员名单失败', errorCode: 'INTERNAL_ERROR', status: 500 };
  }
  if (!taskLearner) {
    return {
      ok: false,
      error: '你不在该任务的学员名单中',
      errorCode: 'LEARNER_NOT_ASSIGNED',
      status: 403,
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
