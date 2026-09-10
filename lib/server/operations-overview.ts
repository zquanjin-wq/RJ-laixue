import type { Pool } from 'pg';

type StatusCount = { status: string; count: number };

function toStatusMap(rows: StatusCount[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

/**
 * A small, query-only operations read model for production diagnosis. It does
 * not expose any learner/course content and deliberately keeps all queue
 * consumers in their own status buckets so one blocked renderer cannot hide a
 * classroom-generation backlog.
 */
export async function readOperationsOverview(pool: Pool) {
  const [courses, generations, videos, revoices, stale] = await Promise.all([
    pool.query<StatusCount>(
      `SELECT save_state AS status, count(*)::integer AS count
       FROM app.courses WHERE deleted_at IS NULL GROUP BY save_state`,
    ),
    pool.query<StatusCount>(
      `SELECT status, count(*)::integer AS count
       FROM app.background_jobs
       WHERE type = 'classroom-generation'
       GROUP BY status`,
    ),
    pool.query<StatusCount>(
      `SELECT status, count(*)::integer AS count
       FROM app.course_video_exports GROUP BY status`,
    ),
    pool.query<StatusCount>(
      `SELECT status, count(*)::integer AS count
       FROM app.course_revoice_jobs GROUP BY status`,
    ),
    pool.query<{
      expiredGenerationLeases: number;
      expiredVideoLeases: number;
      expiredRevoiceLocks: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM app.background_jobs
          WHERE type = 'classroom-generation' AND status = 'running' AND locked_until <= now()) AS "expiredGenerationLeases",
         (SELECT count(*)::integer FROM app.course_video_exports
          WHERE status = 'running' AND worker_lease_expires_at IS NOT NULL AND worker_lease_expires_at <= now()) AS "expiredVideoLeases",
         (SELECT count(*)::integer FROM app.course_revoice_jobs
          WHERE status = 'running' AND locked_until IS NOT NULL AND locked_until <= now()) AS "expiredRevoiceLocks"`,
    ),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    courses: toStatusMap(courses.rows),
    queues: {
      classroomGeneration: toStatusMap(generations.rows),
      videoExport: toStatusMap(videos.rows),
      revoice: toStatusMap(revoices.rows),
    },
    stale: stale.rows[0] ?? {
      expiredGenerationLeases: 0,
      expiredVideoLeases: 0,
      expiredRevoiceLocks: 0,
    },
  };
}
