import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export interface PublishedTask {
  taskId: string;
  shareToken: string;
  publishedAt: Date;
}

export class TaskRepository {
  constructor(private readonly pool: Pool) {}

  async createTask(input: {
    title: string;
    description?: string | null;
    createdBy: string;
    taskType?: 'normal' | 'remedial';
    sourceTaskId?: string | null;
    startAt?: Date | null;
    dueAt?: Date | null;
    completionRule?: unknown;
    courses: Array<{ courseId: string; isRequired?: boolean }>;
    userIds: string[];
  }): Promise<string> {
    const courseIds = [...new Set(input.courses.map((course) => course.courseId))];
    const userIds = [...new Set(input.userIds)];
    if (courseIds.length === 0 || userIds.length === 0) {
      throw new Error('A task requires at least one course and one learner');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.requireRows(client, 'app.courses', 'id', courseIds, 'deleted_at IS NULL');
      await this.requireRows(client, 'public."user"', 'id', userIds, 'banned IS NOT TRUE');

      const task = await client.query<{ id: string }>(
        `INSERT INTO app.learning_tasks
          (title, description, created_by, task_type, source_task_id, start_at, due_at, completion_rule)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         RETURNING id`,
        [
          input.title,
          input.description ?? null,
          input.createdBy,
          input.taskType ?? 'normal',
          input.sourceTaskId ?? null,
          input.startAt ?? null,
          input.dueAt ?? null,
          JSON.stringify(
            input.completionRule ?? {
              version: 1,
              requiredScenes: 'all',
              explicitCompletion: true,
            },
          ),
        ],
      );
      const taskId = task.rows[0].id;

      for (const [index, course] of input.courses.entries()) {
        await client.query(
          `INSERT INTO app.task_courses (task_id, course_id, position, is_required)
           VALUES ($1, $2, $3, $4)`,
          [taskId, course.courseId, index + 1, course.isRequired ?? true],
        );
      }
      for (const userId of userIds) {
        await client.query(`INSERT INTO app.task_assignments (task_id, user_id) VALUES ($1, $2)`, [
          taskId,
          userId,
        ]);
      }
      await client.query('COMMIT');
      return taskId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async publishTask(taskId: string, publishedBy: string): Promise<PublishedTask> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const task = await client.query<{
        status: string;
        shareToken: string | null;
        publishedAt: Date | null;
      }>(
        `SELECT status, share_token AS "shareToken", published_at AS "publishedAt"
         FROM app.learning_tasks WHERE id = $1 FOR UPDATE`,
        [taskId],
      );
      const current = task.rows[0];
      if (!current) throw new Error('Task not found');
      if (current.status === 'published' && current.shareToken && current.publishedAt) {
        await client.query('COMMIT');
        return { taskId, shareToken: current.shareToken, publishedAt: current.publishedAt };
      }
      if (current.status !== 'draft') throw new Error('Only draft tasks can be published');

      const courses = await client.query<{
        courseId: string;
        contentRevision: number;
        content: unknown;
      }>(
        `SELECT c.id AS "courseId", c.content_revision::integer AS "contentRevision", c.content
         FROM app.task_courses tc
         JOIN app.courses c ON c.id = tc.course_id AND c.deleted_at IS NULL
         WHERE tc.task_id = $1
         ORDER BY tc.position`,
        [taskId],
      );
      const assignments = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM app.task_assignments WHERE task_id = $1`,
        [taskId],
      );
      if (courses.rows.length === 0 || assignments.rows[0].count === 0) {
        throw new Error('A task requires courses and learners before publishing');
      }

      for (const course of courses.rows) {
        const snapshot = await client.query<{ id: string }>(
          `INSERT INTO app.course_snapshots (course_id, course_revision, content, created_by)
           VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (course_id, course_revision) DO NOTHING
           RETURNING id`,
          [course.courseId, course.contentRevision, JSON.stringify(course.content), publishedBy],
        );
        const snapshotId =
          snapshot.rows[0]?.id ??
          (
            await client.query<{ id: string }>(
              `SELECT id FROM app.course_snapshots WHERE course_id = $1 AND course_revision = $2`,
              [course.courseId, course.contentRevision],
            )
          ).rows[0].id;
        await client.query(
          `UPDATE app.task_courses SET snapshot_id = $3 WHERE task_id = $1 AND course_id = $2`,
          [taskId, course.courseId, snapshotId],
        );
      }

      await client.query(
        `INSERT INTO app.task_course_progress (task_id, user_id, course_id)
         SELECT a.task_id, a.user_id, c.course_id
         FROM app.task_assignments a
         CROSS JOIN app.task_courses c
         WHERE a.task_id = $1 AND c.task_id = $1
         ON CONFLICT DO NOTHING`,
        [taskId],
      );

      const shareToken = randomUUID();
      const published = await client.query<{ publishedAt: Date }>(
        `UPDATE app.learning_tasks
         SET status = 'published', share_token = $2, published_at = now(), updated_at = now()
         WHERE id = $1
         RETURNING published_at AS "publishedAt"`,
        [taskId, shareToken],
      );
      await client.query('COMMIT');
      return { taskId, shareToken, publishedAt: published.rows[0].publishedAt };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async requireRows(
    client: PoolClient,
    table: string,
    column: string,
    ids: string[],
    condition: string,
  ): Promise<void> {
    const result = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM ${table} WHERE ${column} = ANY($1::text[]) AND ${condition}`,
      [ids],
    );
    if (result.rows[0].count !== ids.length) throw new Error('Task references unavailable records');
  }
}
