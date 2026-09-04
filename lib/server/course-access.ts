/**
 * Shared course-read authorization for runtime course sessions.
 *
 * Better Auth is the identity source. Learner access is derived exclusively
 * from a published learning-task assignment that includes the course; old
 * Supabase students/course_assignments rows are intentionally not consulted.
 */
import { getDatabasePool } from '@/lib/server/db/pool';

export type CourseReadAccess = { ok: true } | { ok: false; reason: 'not_found' | 'forbidden' };

export async function checkCourseReadAccess(
  userId: string,
  courseId: string,
  opts: { shareLink?: boolean } = {},
): Promise<CourseReadAccess> {
  const database = getDatabasePool();
  const [courseResult, actorResult] = await Promise.all([
    database.query<{ ownerUserId: string }>(
      `SELECT owner_user_id AS "ownerUserId"
       FROM app.courses
       WHERE id = $1 AND deleted_at IS NULL`,
      [courseId],
    ),
    database.query<{ role: 'admin' | 'teacher' | 'learner' }>(
      `SELECT p.role
       FROM app.user_profiles p
       JOIN public."user" u ON u.id = p.user_id
       WHERE p.user_id = $1 AND u.banned IS NOT TRUE`,
      [userId],
    ),
  ]);

  const course = courseResult.rows[0];
  if (!course) return { ok: false, reason: 'not_found' };

  const actor = actorResult.rows[0];
  if (!actor) return { ok: false, reason: 'forbidden' };

  if (opts.shareLink || actor.role === 'admin' || course.ownerUserId === userId) {
    return { ok: true };
  }

  if (actor.role !== 'learner') return { ok: false, reason: 'forbidden' };

  const assignmentResult = await database.query(
    `SELECT 1
     FROM app.task_courses task_course
     JOIN app.learning_tasks task ON task.id = task_course.task_id
     JOIN app.task_assignments assignment
       ON assignment.task_id = task_course.task_id
     WHERE task_course.course_id = $1
       AND assignment.user_id = $2
       AND task.status = 'published'`,
    [courseId, userId],
  );
  return assignmentResult.rowCount === 1 ? { ok: true } : { ok: false, reason: 'forbidden' };
}
