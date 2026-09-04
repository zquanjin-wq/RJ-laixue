import type { Pool } from 'pg';
import type { CourseRevoiceJob, CourseRevoiceStatus } from '@/lib/server/course-revoice-jobs';

const columns = `id, course_id, requested_by, status, voice, snapshot, source_updated_at::text,
  items, total_items, completed_items, failed_items, message, error, created_at::text, updated_at::text`;

export class CourseRevoiceRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CourseRevoiceJob) {
    const existing = await this.getActiveForCourse(input.course_id);
    if (existing) return existing;
    try {
      const result = await this.pool.query<CourseRevoiceJob>(
        `INSERT INTO app.course_revoice_jobs
          (id, course_id, requested_by, status, voice, snapshot, source_updated_at, items, total_items, completed_items, failed_items, message)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::timestamptz, $8::jsonb, $9, $10, $11, $12)
         RETURNING ${columns}`,
        [input.id, input.course_id, input.requested_by, input.status, JSON.stringify(input.voice), JSON.stringify(input.snapshot), input.source_updated_at, JSON.stringify(input.items), input.total_items, input.completed_items, input.failed_items, input.message],
      );
      return result.rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        const active = await this.getActiveForCourse(input.course_id);
        if (active) return active;
      }
      throw error;
    }
  }

  async get(jobId: string) {
    const result = await this.pool.query<CourseRevoiceJob>(`SELECT ${columns} FROM app.course_revoice_jobs WHERE id = $1`, [jobId]);
    return result.rows[0] ?? null;
  }

  async getLatestForCourse(courseId: string) {
    const result = await this.pool.query<CourseRevoiceJob>(`SELECT ${columns} FROM app.course_revoice_jobs WHERE course_id = $1 ORDER BY created_at DESC LIMIT 1`, [courseId]);
    return result.rows[0] ?? null;
  }

  async cancel(jobId: string, courseId: string) {
    const result = await this.pool.query<CourseRevoiceJob>(
      `UPDATE app.course_revoice_jobs
          SET status = 'cancelled', message = 'Cancelled; the course keeps its existing voice.', completed_at = now(), locked_until = NULL, updated_at = now()
        WHERE id = $1 AND course_id = $2 AND status IN ('queued', 'running')
        RETURNING ${columns}`,
      [jobId, courseId],
    );
    return result.rows[0] ?? null;
  }

  async claim(jobId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<CourseRevoiceJob>(
        `SELECT ${columns} FROM app.course_revoice_jobs
         WHERE id = $1 AND (locked_until IS NULL OR locked_until < now())
         FOR UPDATE`,
        [jobId],
      );
      const job = result.rows[0];
      if (!job || !['queued', 'running'].includes(job.status)) { await client.query('COMMIT'); return null; }
      const claimed = await client.query<CourseRevoiceJob>(
        `UPDATE app.course_revoice_jobs
            SET status = 'running', locked_until = now() + interval '5 minutes', updated_at = now()
          WHERE id = $1
          RETURNING ${columns}`,
        [jobId],
      );
      await client.query('COMMIT');
      return claimed.rows[0] ?? null;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async updateRunning(jobId: string, patch: { items: unknown; completedItems: number; failedItems?: number; status?: CourseRevoiceStatus; message?: string; error?: string | null; lockedUntil?: Date | null; completed?: boolean }) {
    const result = await this.pool.query<CourseRevoiceJob>(
      `UPDATE app.course_revoice_jobs SET
          items = $2::jsonb, completed_items = $3, failed_items = COALESCE($4, failed_items),
          status = COALESCE($5, status), message = COALESCE($6, message), error = $7,
          locked_until = $8, completed_at = CASE WHEN $9 THEN now() ELSE completed_at END, updated_at = now()
        WHERE id = $1 AND status = 'running'
        RETURNING ${columns}`,
      [jobId, JSON.stringify(patch.items), patch.completedItems, patch.failedItems ?? null, patch.status ?? null, patch.message ?? null, patch.error ?? null, patch.lockedUntil ?? null, patch.completed ?? false],
    );
    return result.rows[0] ?? null;
  }

  async fail(jobId: string, message: string) {
    const result = await this.pool.query<CourseRevoiceJob>(
      `UPDATE app.course_revoice_jobs
          SET status = 'failed', message = $2, error = $2, locked_until = NULL, completed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'running'
        RETURNING ${columns}`,
      [jobId, message],
    );
    return result.rows[0] ?? null;
  }

  async getCourse(courseId: string) {
    const result = await this.pool.query<{ content: unknown; updatedAt: string }>(
      `SELECT content, updated_at::text AS "updatedAt" FROM app.courses WHERE id = $1 AND deleted_at IS NULL`, [courseId],
    );
    return result.rows[0] ?? null;
  }

  async commit(jobId: string, courseId: string, sourceUpdatedAt: string, content: unknown) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const job = await client.query<{ status: string }>(`SELECT status FROM app.course_revoice_jobs WHERE id = $1 FOR UPDATE`, [jobId]);
      if (job.rows[0]?.status !== 'running') { await client.query('COMMIT'); return 'cancelled'; }
      const course = await client.query<{ id: string }>(`SELECT id FROM app.courses WHERE id = $1 AND date_trunc('milliseconds', updated_at) = $2::timestamptz FOR UPDATE`, [courseId, sourceUpdatedAt]);
      if (!course.rows[0]) { await client.query(`UPDATE app.course_revoice_jobs SET status = 'conflict', message = 'Course changed while revoice was running.', locked_until = NULL, completed_at = now(), updated_at = now() WHERE id = $1`, [jobId]); await client.query('COMMIT'); return 'conflict'; }
      await client.query(`UPDATE app.courses SET content = $2::jsonb, content_revision = content_revision + 1, updated_at = now() WHERE id = $1`, [courseId, JSON.stringify(content)]);
      await client.query(`UPDATE app.course_revoice_jobs SET status = 'succeeded', message = 'Revoice completed.', locked_until = NULL, completed_at = now(), updated_at = now() WHERE id = $1`, [jobId]);
      await client.query('COMMIT');
      return 'succeeded';
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async nextRunnable() {
    const result = await this.pool.query<{ id: string }>(`SELECT id FROM app.course_revoice_jobs WHERE status IN ('queued', 'running') AND (locked_until IS NULL OR locked_until < now()) ORDER BY created_at LIMIT 1`);
    return result.rows[0]?.id ?? null;
  }

  private async getActiveForCourse(courseId: string) {
    const result = await this.pool.query<CourseRevoiceJob>(`SELECT ${columns} FROM app.course_revoice_jobs WHERE course_id = $1 AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`, [courseId]);
    return result.rows[0] ?? null;
  }
}
