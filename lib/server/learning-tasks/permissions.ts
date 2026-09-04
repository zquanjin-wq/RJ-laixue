import { AccessRepository, type AppRole } from '@/lib/server/db/access-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export type UserRole = AppRole;
export interface ResolvedActor { userId: string; role: UserRole; }
export type CoursePublishPermission = { ok: true } | { ok: false; reason: 'course_not_found' | 'not_admin_or_teacher' | 'course_not_owned' };
export type TaskManagePermission = { ok: true } | { ok: false; reason: 'not_admin_or_teacher' | 'task_not_found' | 'not_task_owner' };
export type TaskEntryPermission = | { ok: true; actor: 'learner'; studentId: string; taskLearnerId: string } | { ok: true; actor: 'preview'; role: 'admin' | 'teacher' } | { ok: false; reason: 'learner_not_bound' | 'learner_not_assigned' | 'learner_disabled' };

export async function resolveActor(userId: string): Promise<ResolvedActor> {
  const actor = await new AccessRepository(getDatabasePool()).resolveActor(userId);
  return actor ?? { userId, role: 'learner' };
}

export async function checkCoursePublishPermission(userId: string, courseId: string): Promise<CoursePublishPermission> {
  const actor = await resolveActor(userId);
  const pool = getDatabasePool();
  const course = await pool.query<{ ownerUserId: string }>(`SELECT owner_user_id AS "ownerUserId" FROM app.courses WHERE id = $1 AND deleted_at IS NULL`, [courseId]);
  if (!course.rows[0]) return { ok: false, reason: 'course_not_found' };
  if (actor.role === 'admin') return { ok: true };
  if (actor.role !== 'teacher') return { ok: false, reason: 'not_admin_or_teacher' };
  return course.rows[0].ownerUserId === userId ? { ok: true } : { ok: false, reason: 'course_not_owned' };
}

export async function checkTaskManagePermission(userId: string, taskId: string): Promise<TaskManagePermission> {
  const actor = await resolveActor(userId);
  const pool = getDatabasePool();
  const task = await pool.query<{ createdBy: string }>(`SELECT created_by AS "createdBy" FROM app.learning_tasks WHERE id = $1`, [taskId]);
  if (!task.rows[0]) return { ok: false, reason: 'task_not_found' };
  if (actor.role === 'admin') return { ok: true };
  if (actor.role !== 'teacher') return { ok: false, reason: 'not_admin_or_teacher' };
  return task.rows[0].createdBy === userId ? { ok: true } : { ok: false, reason: 'not_task_owner' };
}

export async function checkTaskEntryPermission(userId: string, taskId: string): Promise<TaskEntryPermission> {
  const actor = await new AccessRepository(getDatabasePool()).resolveActor(userId);
  if (!actor) return { ok: false, reason: 'learner_not_bound' };
  if (actor.role === 'admin') return { ok: true, actor: 'preview', role: 'admin' };
  const pool = getDatabasePool();
  if (actor.role === 'teacher') {
    const owned = await pool.query(`SELECT 1 FROM app.learning_tasks WHERE id = $1 AND created_by = $2`, [taskId, userId]);
    if (owned.rowCount === 1) return { ok: true, actor: 'preview', role: 'teacher' };
  }
  if (actor.role !== 'learner') return { ok: false, reason: 'learner_not_assigned' };
  const assignment = await pool.query(`SELECT 1 FROM app.task_assignments WHERE task_id = $1 AND user_id = $2`, [taskId, userId]);
  return assignment.rowCount === 1 ? { ok: true, actor: 'learner', studentId: userId, taskLearnerId: userId } : { ok: false, reason: 'learner_not_assigned' };
}
