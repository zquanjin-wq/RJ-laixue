/**
 * 任务权限领域服务
 *
 * 集中式权限判定，不在各 route 重复散落判断。
 * 规则：
 *   - admin：读写/管理全部任务
 *   - teacher：只能创建自己有权发布课程的 task，只能管理 created_by = auth.uid() 的 task
 *   - learner：不能调用管理 API
 *   - 缺失 profile 默认 learner
 */
import { getServiceSupabase } from '@/lib/supabase/server';

// ============================================================
// 类型
// ============================================================

export type UserRole = 'admin' | 'teacher' | 'learner';

export interface ResolvedActor {
  userId: string;
  role: UserRole;
}

/** 课程发布权限 */
export type CoursePublishPermission =
  | { ok: true }
  | { ok: false; reason: 'course_not_found' | 'not_admin_or_teacher' | 'course_not_owned' };

/** 任务管理权限 */
export type TaskManagePermission =
  | { ok: true }
  | { ok: false; reason: 'not_admin_or_teacher' | 'task_not_found' | 'not_task_owner' };

// ============================================================
// Actor 解析
// ============================================================

/**
 * 从 auth.uid() 解析调用者角色。
 * 缺失 profile 默认 learner。
 */
export async function resolveActor(userId: string): Promise<ResolvedActor> {
  const { data: profile } = await getServiceSupabase()
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();

  const role: UserRole =
    profile?.role === 'admin' || profile?.role === 'teacher' ? profile.role : 'learner';

  return { userId, role };
}

// ============================================================
// 课程发布权限
// ============================================================

/**
 * 判定是否可基于某课程发布任务。
 * 沿用 course-access.ts 的规则：admin 可发布；teacher 对 created_by=null 的历史课程可发布。
 */
export async function checkCoursePublishPermission(
  userId: string,
  courseId: string,
): Promise<CoursePublishPermission> {
  const actor = await resolveActor(userId);

  // admin 可发布全部
  if (actor.role === 'admin') return { ok: true };

  // learner 不可进入管理流程
  if (actor.role === 'learner') return { ok: false, reason: 'not_admin_or_teacher' };

  // teacher：检查课程 owner
  const { data: course } = await getServiceSupabase()
    .from('courses')
    .select('id, created_by')
    .eq('id', courseId)
    .maybeSingle();

  if (!course) return { ok: false, reason: 'course_not_found' };

  // teacher 对明确属于他人的课程不可发布
  if (course.created_by && course.created_by !== userId) {
    return { ok: false, reason: 'course_not_owned' };
  }

  // created_by 为 null/'' 的遗留课程，兼容放行
  return { ok: true };
}

// ============================================================
// 任务管理权限
// ============================================================

/**
 * 判定是否可管理特定任务（PATCH/archive/learners）。
 */
export async function checkTaskManagePermission(
  userId: string,
  taskId: string,
): Promise<TaskManagePermission> {
  const actor = await resolveActor(userId);

  // admin 管理全部
  if (actor.role === 'admin') return { ok: true };

  // learner 不可管理
  if (actor.role === 'learner') return { ok: false, reason: 'not_admin_or_teacher' };

  // teacher：检查任务 owner
  const { data: task } = await getServiceSupabase()
    .from('learning_tasks')
    .select('id, created_by')
    .eq('id', taskId)
    .maybeSingle();

  if (!task) return { ok: false, reason: 'task_not_found' };

  if (task.created_by !== userId) {
    return { ok: false, reason: 'not_task_owner' };
  }

  return { ok: true };
}

// ============================================================
// 学员入口权限
// ============================================================

/**
 * 判定登录学员是否能通过 token 进入任务。
 * 返回 learner 身份或 preview。
 */
export type TaskEntryPermission =
  | { ok: true; actor: 'learner'; studentId: string; taskLearnerId: string }
  | { ok: true; actor: 'preview'; role: 'admin' | 'teacher' }
  | { ok: false; reason: 'learner_not_bound' | 'learner_not_assigned' | 'learner_disabled' };

export async function checkTaskEntryPermission(
  userId: string,
  taskId: string,
): Promise<TaskEntryPermission> {
  const actor = await resolveActor(userId);

  // admin/teacher 预览
  if (actor.role === 'admin') {
    return { ok: true, actor: 'preview', role: actor.role };
  }
  if (actor.role === 'teacher') {
    const { data: task } = await getServiceSupabase()
      .from('learning_tasks')
      .select('id')
      .eq('id', taskId)
      .eq('created_by', userId)
      .maybeSingle();

    if (!task) return { ok: false, reason: 'learner_not_assigned' };
    return { ok: true, actor: 'preview', role: actor.role };
  }

  // learner
  const { data: student } = await getServiceSupabase()
    .from('students')
    .select('id, disabled_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (!student) return { ok: false, reason: 'learner_not_bound' };
  if (student.disabled_at) return { ok: false, reason: 'learner_disabled' };

  const { data: taskLearner } = await getServiceSupabase()
    .from('task_learners')
    .select('id, student_id')
    .eq('task_id', taskId)
    .eq('student_id', student.id)
    .maybeSingle();

  if (!taskLearner) return { ok: false, reason: 'learner_not_assigned' };

  return {
    ok: true,
    actor: 'learner',
    studentId: student.id,
    taskLearnerId: taskLearner.id,
  };
}
