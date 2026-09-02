import type { Pool } from 'pg';

export type AppRole = 'admin' | 'teacher' | 'learner';

export interface DatabaseActor {
  userId: string;
  role: AppRole;
}

export class AccessRepository {
  constructor(private readonly pool: Pool) {}

  async resolveActor(userId: string): Promise<DatabaseActor | null> {
    const result = await this.pool.query<{ userId: string; role: AppRole }>(
      `SELECT p.user_id AS "userId", p.role
       FROM app.user_profiles p
       JOIN public."user" u ON u.id = p.user_id
       WHERE p.user_id = $1 AND u.banned IS NOT TRUE`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  requireRole(actor: DatabaseActor, roles: AppRole[]): void {
    if (!roles.includes(actor.role)) throw new Error('Forbidden');
  }

  async canManageCourse(actor: DatabaseActor, courseId: string): Promise<boolean> {
    if (actor.role === 'admin') return true;
    if (actor.role !== 'teacher') return false;
    const result = await this.pool.query(
      `SELECT 1 FROM app.courses
       WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
      [courseId, actor.userId],
    );
    return result.rowCount === 1;
  }

  async canManageTask(actor: DatabaseActor, taskId: string): Promise<boolean> {
    if (actor.role === 'admin') return true;
    if (actor.role !== 'teacher') return false;
    const result = await this.pool.query(
      `SELECT 1 FROM app.learning_tasks WHERE id = $1 AND created_by = $2`,
      [taskId, actor.userId],
    );
    return result.rowCount === 1;
  }

  async canEnterTask(actor: DatabaseActor, taskId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
       FROM app.learning_tasks task
       WHERE task.id = $1
         AND task.status = 'published'
         AND (
           task.created_by = $2 OR
           EXISTS (
             SELECT 1 FROM app.task_assignments assignment
             WHERE assignment.task_id = task.id AND assignment.user_id = $2
           )
         )`,
      [taskId, actor.userId],
    );
    return actor.role === 'admin' || result.rowCount === 1;
  }
}
