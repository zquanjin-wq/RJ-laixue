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
  updated_at AS "updatedAt"
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

  async claimNext(): Promise<CourseVideoExport | null> {
    const result = await this.pool.query<CourseVideoExport>(
      `WITH candidate AS (
         SELECT id AS candidate_id FROM app.course_video_exports
         WHERE status = 'queued'
           AND request ? 'inputObjectKey'
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE app.course_video_exports export
       SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now(), error = NULL
       FROM candidate
       WHERE export.id = candidate.candidate_id
       RETURNING ${columns}`,
    );
    return result.rows[0] ?? null;
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
       SET status = 'queued', error = NULL, started_at = NULL, completed_at = NULL, updated_at = now()
       WHERE id = $1 AND status IN ('failed', 'cancelled') AND request ? 'inputObjectKey'
       RETURNING ${columns}`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async updateStatus(input: {
    id: string;
    status: MutableCourseVideoExportStatus;
    expectedStatuses?: MutableCourseVideoExportStatus[];
    error?: string | null;
  }): Promise<CourseVideoExport | null> {
    const result = await this.pool.query<CourseVideoExport>(
      `UPDATE app.course_video_exports
       SET status = $2,
           error = $3,
           started_at = CASE WHEN $2 = 'running' THEN COALESCE(started_at, now()) ELSE started_at END,
           completed_at = CASE WHEN $2 IN ('failed', 'cancelled') THEN now() ELSE NULL END,
           updated_at = now()
       WHERE id = $1
         AND ($4::text[] IS NULL OR status = ANY($4::text[]))
       RETURNING ${columns}`,
      [
        input.id,
        input.status,
        input.error ?? null,
        input.expectedStatuses ?? ['queued', 'running'],
      ],
    );
    return result.rows[0] ?? null;
  }

  async recordOutput(input: {
    id: string;
    output: CosObjectReference;
    expectedStatuses?: MutableCourseVideoExportStatus[];
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
           updated_at = now()
       WHERE id = $1
         AND ($7::text[] IS NULL OR status = ANY($7::text[]))
       RETURNING ${columns}`,
      [
        input.id,
        input.output.bucket,
        input.output.objectKey,
        input.output.contentType,
        input.output.sizeBytes,
        input.output.etag ?? null,
        input.expectedStatuses ?? ['running'],
      ],
    );
    return result.rows[0] ?? null;
  }
}
