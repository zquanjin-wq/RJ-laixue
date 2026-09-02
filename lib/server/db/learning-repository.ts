import type { Pool } from 'pg';

export class LearningRepository {
  constructor(private readonly pool: Pool) {}

  async startAttempt(input: {
    taskId: string;
    userId: string;
    courseId?: string | null;
    sessionKey: string;
  }): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO app.learning_attempts (task_id, user_id, course_id, session_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (task_id, user_id, session_key) DO UPDATE
         SET last_activity_at = now(), updated_at = now()
       RETURNING id`,
      [input.taskId, input.userId, input.courseId ?? null, input.sessionKey],
    );
    return result.rows[0].id;
  }

  async recordEvent(input: {
    attemptId: string;
    taskId: string;
    userId: string;
    courseId?: string | null;
    clientEventId: string;
    eventType: string;
    sceneId?: string | null;
    sceneOrder?: number | null;
    payload?: unknown;
    occurredAt: Date;
    effectiveSecondsDelta?: number;
    progressPercent?: number;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO app.learning_events
          (attempt_id, task_id, user_id, course_id, client_event_id, event_type, scene_id, scene_order, payload, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         ON CONFLICT (task_id, user_id, client_event_id) DO NOTHING
         RETURNING id`,
        [
          input.attemptId,
          input.taskId,
          input.userId,
          input.courseId ?? null,
          input.clientEventId,
          input.eventType,
          input.sceneId ?? null,
          input.sceneOrder ?? null,
          JSON.stringify(input.payload ?? {}),
          input.occurredAt,
        ],
      );
      if (inserted.rowCount === 0) {
        await client.query('COMMIT');
        return false;
      }

      const seconds = Math.max(0, Math.trunc(input.effectiveSecondsDelta ?? 0));
      await client.query(
        `UPDATE app.learning_attempts
         SET last_activity_at = now(), effective_seconds = effective_seconds + $2, updated_at = now()
         WHERE id = $1`,
        [input.attemptId, seconds],
      );
      await client.query(
        `UPDATE app.task_assignments
         SET status = CASE WHEN status = 'not_started' THEN 'in_progress' ELSE status END,
             started_at = COALESCE(started_at, now()),
             last_seen_at = now(),
             last_scene_id = COALESCE($4, last_scene_id),
             effective_seconds = effective_seconds + $3,
             progress_percent = COALESCE($5, progress_percent),
             updated_at = now()
         WHERE task_id = $1 AND user_id = $2`,
        [input.taskId, input.userId, seconds, input.sceneId ?? null, input.progressPercent ?? null],
      );
      if (input.courseId) {
        await client.query(
          `UPDATE app.task_course_progress
           SET status = CASE WHEN status = 'not_started' THEN 'in_progress' ELSE status END,
               started_at = COALESCE(started_at, now()),
               last_seen_at = now(),
               effective_seconds = effective_seconds + $4,
               progress_percent = COALESCE($5, progress_percent),
               updated_at = now()
           WHERE task_id = $1 AND user_id = $2 AND course_id = $3`,
          [input.taskId, input.userId, input.courseId, seconds, input.progressPercent ?? null],
        );
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
