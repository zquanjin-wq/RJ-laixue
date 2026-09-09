import type { Pool } from 'pg';

export type CourseVideoExportStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
type MutableCourseVideoExportStatus = Exclude<CourseVideoExportStatus, 'succeeded'>;

export interface CosObjectReference {
  bucket: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  etag?: string | null;
}

export interface CourseVideoExport {
  id: string;
  courseId: string;
  requestedBy: string;
  status: CourseVideoExportStatus;
  request: unknown;
  output: CosObjectReference | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  workerId: string | null;
  workerLeaseExpiresAt: Date | null;
}

export interface CourseVideoExportQueueInfo {
  /** One-based position including renders already in progress. */
  position: number | null;
  /** Historical estimate; null until enough completed renders exist. */
  estimatedWaitSeconds: number | null;
}

const columns = `
  id,
  course_id AS "courseId",
  requested_by AS "requestedBy",
  status,
  request,
  CASE WHEN output_object_key IS NULL THEN NULL ELSE jsonb_build_object(
    'bucket', output_bucket,
    'objectKey', output_object_key,
    'contentType', output_content_type,
    'sizeBytes', output_size_bytes,
    'etag', output_etag
  ) END AS output,
  error,
  created_at AS "createdAt",
  started_at AS "startedAt",
  completed_at AS "completedAt",
  updated_at AS "updatedAt",
  worker_id AS "workerId",
  worker_lease_expires_at AS "workerLeaseExpiresAt"
`;

export class CourseVideoExportRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    courseId: string;
    requestedBy: string;
    request?: unknown;
  }): Promise<CourseVideoExport> {
    const result = await this.pool.query<CourseVideoExport>(
      `INSERT INTO app.course_video_exports (course_id, requested_by, request)
       VALUES ($1, $2, $3::jsonb)
       RETURNING ${columns}`,
      [input.courseId, input.requestedBy, JSON.stringify(input.request ?? {})],
    );
    return result.rows[0];
  }

  async get(exportId: string): Promise<CourseVideoExport | null> {
    const result = await this.pool.query<CourseVideoExport>(
      `SELECT ${columns} FROM app.course_video_exports WHERE id = $1`,
      [exportId],
    );
    return result.rows[0] ?? null;
  }

  async listForCourse(courseId: string, limit = 20): Promise<CourseVideoExport[]> {
    const result = await this.pool.query<CourseVideoExport>(
      `SELECT ${columns}
       FROM app.course_video_exports
       WHERE course_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [courseId, limit],
    );
    return result.rows;
  }

  async claimNext(
    workerId = 'legacy-video-worker',
    leaseMs = 5 * 60 * 1000,
  ): Promise<CourseVideoExport | null> {
    if (!workerId.trim()) throw new Error('Video export worker ID is required');
    const result = await this.pool.query<CourseVideoExport>(
      `WITH candidate AS (
         SELECT id AS candidate_id FROM app.course_video_exports
         WHERE request ? 'inputObjectKey'
           AND (
             status = 'queued'
             OR (status = 'running' AND (worker_lease_expires_at IS NULL OR worker_lease_expires_at <= clock_timestamp()))
           )
         -- Recover an expired lease before admitting newer work. Otherwise a
         -- dead agent's task can be stranded behind a permanently busy queue.
         ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE app.course_video_exports export
       SET status = 'running',
           started_at = COALESCE(started_at, now()),
           updated_at = now(),
           error = NULL,
           -- A replacement agent cannot rely on an in-memory renderer job from
           -- the disappeared host. Keep the durable ZIP and submit it to its
           -- own renderer instead of polling a foreign job ID.
           request = CASE WHEN export.status = 'running' THEN export.request - 'render' ELSE export.request END,
           worker_id = $1,
           worker_lease_expires_at = clock_timestamp() + ($2::bigint * interval '1 millisecond')
       FROM candidate
       WHERE export.id = candidate.candidate_id
       RETURNING ${columns}`,
      [workerId, leaseMs],
    );
    return result.rows[0] ?? null;
  }

  async heartbeat(id: string, workerId: string, leaseMs: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE app.course_video_exports
       SET worker_lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
           updated_at = now()
       WHERE id = $1 AND status = 'running' AND worker_id = $2
         AND worker_lease_expires_at > clock_timestamp()`,
      [id, workerId, leaseMs],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async activateInput(id: string): Promise<CourseVideoExport | null> {
    const result = await this.pool.query<CourseVideoExport>(
      `UPDATE app.course_video_exports
       SET request = (request - 'uploadObjectKey') || jsonb_build_object('inputObjectKey', request->>'uploadObjectKey'),
           updated_at = now()
       WHERE id = $1 AND status = 'queued' AND request ? 'uploadObjectKey'
       RETURNING ${columns}`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async retry(id: string): Promise<CourseVideoExport | null> {
    const result = await this.pool.query<CourseVideoExport>(
      `UPDATE app.course_video_exports
       SET status = 'queued', error = NULL, started_at = NULL, completed_at = NULL,
           -- A failed renderer job may have been lost during a renderer restart.
           -- Preserve the durable ZIP input but force a fresh renderer submission.
           request = request - 'render', updated_at = now()
       WHERE id = $1 AND status IN ('failed', 'cancelled') AND request ? 'inputObjectKey'
       RETURNING ${columns}`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async updateRenderProgress(input: {
    id: string;
    workerId?: string;
    leaseMs?: number;
    renderJobId: string;
    progress: number;
    currentStage?: string;
    framesRendered?: number;
    totalFrames?: number;
  }): Promise<CourseVideoExport | null> {
    const render = {
      jobId: input.renderJobId,
      progress: Math.max(0, Math.min(1, input.progress)),
      currentStage: input.currentStage ?? null,
      framesRendered: input.framesRendered ?? null,
      totalFrames: input.totalFrames ?? null,
    };
    const result = await this.pool.query<CourseVideoExport>(
      `UPDATE app.course_video_exports
       SET request = jsonb_set(request, '{render}', $2::jsonb, true),
           worker_lease_expires_at = CASE WHEN $3::text IS NULL THEN worker_lease_expires_at ELSE clock_timestamp() + ($4::bigint * interval '1 millisecond') END,
           updated_at = now()
       WHERE id = $1 AND status = 'running'
         AND ($3::text IS NULL OR (worker_id = $3 AND worker_lease_expires_at > clock_timestamp()))
       RETURNING ${columns}`,
      [input.id, JSON.stringify(render), input.workerId ?? null, input.leaseMs ?? 0],
    );
    return result.rows[0] ?? null;
  }

  async failStaleRunning(maxAgeMs: number): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `UPDATE app.course_video_exports
       SET status = 'failed',
           error = '视频渲染进程长时间未响应，任务已停止。请重试。',
           completed_at = now(),
           updated_at = now()
       WHERE status = 'running'
         AND NOT (request ? 'render')
         AND (worker_lease_expires_at IS NULL OR worker_lease_expires_at <= clock_timestamp())
         AND updated_at < now() - ($1::bigint * interval '1 millisecond')
       RETURNING id`,
      [maxAgeMs],
    );
    return result.rowCount ?? 0;
  }

  async updateStatus(input: {
    id: string;
    status: MutableCourseVideoExportStatus;
    expectedStatuses?: MutableCourseVideoExportStatus[];
    error?: string | null;
    expectedWorkerId?: string;
  }): Promise<CourseVideoExport | null> {
    const result = await this.pool.query<CourseVideoExport>(
      `UPDATE app.course_video_exports
       SET status = $2,
           error = $3,
           started_at = CASE WHEN $2 = 'running' THEN COALESCE(started_at, now()) ELSE started_at END,
           completed_at = CASE WHEN $2 IN ('failed', 'cancelled') THEN now() ELSE NULL END,
           worker_id = CASE WHEN $2 IN ('failed', 'cancelled') THEN NULL ELSE worker_id END,
           worker_lease_expires_at = CASE WHEN $2 IN ('failed', 'cancelled') THEN NULL ELSE worker_lease_expires_at END,
           updated_at = now()
       WHERE id = $1
         AND ($4::text[] IS NULL OR status = ANY($4::text[]))
         AND ($5::text IS NULL OR worker_id = $5)
       RETURNING ${columns}`,
      [
        input.id,
        input.status,
        input.error ?? null,
        input.expectedStatuses ?? ['queued', 'running'],
        input.expectedWorkerId ?? null,
      ],
    );
    return result.rows[0] ?? null;
  }

  async recordOutput(input: {
    id: string;
    output: CosObjectReference;
    expectedStatuses?: MutableCourseVideoExportStatus[];
    expectedWorkerId?: string;
  }): Promise<CourseVideoExport | null> {
    const result = await this.pool.query<CourseVideoExport>(
      `UPDATE app.course_video_exports
       SET status = 'succeeded',
           output_bucket = $2,
           output_object_key = $3,
           output_content_type = $4,
           output_size_bytes = $5,
           output_etag = $6,
           error = NULL,
           completed_at = now(),
           worker_id = NULL,
           worker_lease_expires_at = NULL,
           updated_at = now()
       WHERE id = $1
         AND ($7::text[] IS NULL OR status = ANY($7::text[]))
         AND ($8::text IS NULL OR worker_id = $8)
       RETURNING ${columns}`,
      [
        input.id,
        input.output.bucket,
        input.output.objectKey,
        input.output.contentType,
        input.output.sizeBytes,
        input.output.etag ?? null,
        input.expectedStatuses ?? ['running'],
        input.expectedWorkerId ?? null,
      ],
    );
    return result.rows[0] ?? null;
  }

  async getQueueInfo(id: string, parallelism: number): Promise<CourseVideoExportQueueInfo> {
    const result = await this.pool.query<CourseVideoExportQueueInfo>(
      `WITH target AS (
         SELECT id, status, created_at FROM app.course_video_exports WHERE id = $1
       ), history AS (
         SELECT EXTRACT(EPOCH FROM (completed_at - started_at))::double precision AS seconds
         FROM app.course_video_exports
         WHERE status = 'succeeded' AND started_at IS NOT NULL AND completed_at IS NOT NULL
         ORDER BY completed_at DESC
         LIMIT 20
       ), queue AS (
         SELECT CASE WHEN target.status = 'queued' THEN (
           SELECT count(*)::int + 1
           FROM app.course_video_exports candidate
           WHERE candidate.id <> target.id
             AND candidate.request ? 'inputObjectKey'
             AND (candidate.status = 'running' OR (candidate.status = 'queued' AND candidate.created_at <= target.created_at))
         ) ELSE NULL END AS position
         FROM target
       )
       SELECT queue.position AS position,
         CASE WHEN queue.position IS NULL OR NOT EXISTS (SELECT 1 FROM history) THEN NULL
           ELSE CEIL((SELECT avg(seconds) FROM history) * GREATEST(queue.position - 1, 0) / GREATEST($2::integer, 1))::integer
         END AS "estimatedWaitSeconds"
       FROM queue`,
      [id, Math.max(1, Math.floor(parallelism))],
    );
    return result.rows[0] ?? { position: null, estimatedWaitSeconds: null };
  }
}
