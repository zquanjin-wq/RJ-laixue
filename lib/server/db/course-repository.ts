import type { Pool, PoolClient } from 'pg';

export type CourseSaveState = 'draft' | 'ready' | 'failed';
export type CourseAssetKind = 'audio' | 'image' | 'material' | 'video' | 'pbl' | 'other';

export interface CourseRecord {
  id: string;
  ownerUserId: string;
  title: string;
  topic: string | null;
  content: unknown;
  saveState: CourseSaveState;
  contentRevision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CourseAssetRecord {
  id: string;
  courseId: string | null;
  ownerUserId: string;
  kind: CourseAssetKind;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  state: 'pending' | 'ready' | 'deleting' | 'deleted' | 'failed';
  createdAt: Date;
  boundAt: Date | null;
}

export interface CourseSnapshotRecord {
  id: string;
  courseId: string;
  courseRevision: number;
  content: unknown;
  createdBy: string;
  createdAt: Date;
}

const courseColumns = `
  id,
  owner_user_id AS "ownerUserId",
  title,
  topic,
  content,
  save_state AS "saveState",
  content_revision::integer AS "contentRevision",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export class CourseRepository {
  constructor(private readonly pool: Pool) {}

  async createCourse(input: {
    id: string;
    ownerUserId: string;
    title: string;
    topic?: string | null;
    content: unknown;
    saveState?: CourseSaveState;
  }): Promise<CourseRecord> {
    const result = await this.pool.query<CourseRecord>(
      `INSERT INTO app.courses
        (id, owner_user_id, title, topic, content, save_state)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING ${courseColumns}`,
      [
        input.id,
        input.ownerUserId,
        input.title,
        input.topic ?? null,
        JSON.stringify(input.content),
        input.saveState ?? 'draft',
      ],
    );
    return result.rows[0];
  }

  async getCourse(courseId: string): Promise<CourseRecord | null> {
    const result = await this.pool.query<CourseRecord>(
      `SELECT ${courseColumns}
       FROM app.courses
       WHERE id = $1 AND deleted_at IS NULL`,
      [courseId],
    );
    return result.rows[0] ?? null;
  }

  async listOwnedCourses(ownerUserId: string): Promise<CourseRecord[]> {
    const result = await this.pool.query<CourseRecord>(
      `SELECT ${courseColumns}
       FROM app.courses
       WHERE owner_user_id = $1 AND deleted_at IS NULL
       ORDER BY updated_at DESC, id`,
      [ownerUserId],
    );
    return result.rows;
  }

  async listCourses(): Promise<CourseRecord[]> {
    const result = await this.pool.query<CourseRecord>(
      `SELECT ${courseColumns}
       FROM app.courses
       WHERE deleted_at IS NULL
       ORDER BY updated_at DESC, id`,
    );
    return result.rows;
  }

  async updateCourse(input: {
    id: string;
    ownerUserId: string;
    expectedRevision: number;
    title: string;
    topic?: string | null;
    content: unknown;
    saveState: CourseSaveState;
  }): Promise<CourseRecord | null> {
    const result = await this.pool.query<CourseRecord>(
      `UPDATE app.courses
       SET title = $4,
           topic = $5,
           content = $6::jsonb,
           save_state = $7,
           content_revision = content_revision + 1,
           updated_at = now()
       WHERE id = $1
         AND owner_user_id = $2
         AND content_revision = $3
         AND deleted_at IS NULL
       RETURNING ${courseColumns}`,
      [
        input.id,
        input.ownerUserId,
        input.expectedRevision,
        input.title,
        input.topic ?? null,
        JSON.stringify(input.content),
        input.saveState,
      ],
    );
    return result.rows[0] ?? null;
  }

  async softDeleteCourse(courseId: string, ownerUserId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE app.courses
       SET deleted_at = now(), updated_at = now()
       WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
      [courseId, ownerUserId],
    );
    return result.rowCount === 1;
  }

  async createAsset(input: {
    ownerUserId: string;
    courseId?: string | null;
    kind: CourseAssetKind;
    objectKey: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<CourseAssetRecord> {
    const result = await this.pool.query<CourseAssetRecord>(
      `INSERT INTO app.course_assets
        (owner_user_id, course_id, kind, object_key, content_type, size_bytes, state, bound_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $2::text IS NULL THEN NULL ELSE now() END)
       RETURNING
         id,
         course_id AS "courseId",
         owner_user_id AS "ownerUserId",
         kind,
         object_key AS "objectKey",
         content_type AS "contentType",
         size_bytes::double precision AS "sizeBytes",
         state,
         created_at AS "createdAt",
         bound_at AS "boundAt"`,
      [
        input.ownerUserId,
        input.courseId ?? null,
        input.kind,
        input.objectKey,
        input.contentType,
        input.sizeBytes,
        input.courseId ? 'ready' : 'pending',
      ],
    );
    return result.rows[0];
  }

  async getAssetByObjectKey(objectKey: string): Promise<CourseAssetRecord | null> {
    const result = await this.pool.query<CourseAssetRecord>(
      `SELECT
         id,
         course_id AS "courseId",
         owner_user_id AS "ownerUserId",
         kind,
         object_key AS "objectKey",
         content_type AS "contentType",
         size_bytes::double precision AS "sizeBytes",
         state,
         created_at AS "createdAt",
         bound_at AS "boundAt"
       FROM app.course_assets
       WHERE object_key = $1 AND deleted_at IS NULL`,
      [objectKey],
    );
    return result.rows[0] ?? null;
  }

  async createSnapshot(courseId: string, createdBy: string): Promise<CourseSnapshotRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const course = await client.query<{ content: unknown; contentRevision: number }>(
        `SELECT content, content_revision AS "contentRevision"
         FROM app.courses
         WHERE id = $1 AND deleted_at IS NULL
         FOR SHARE`,
        [courseId],
      );
      if (!course.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }

      const snapshot = await this.insertSnapshot(
        client,
        courseId,
        course.rows[0].contentRevision,
        course.rows[0].content,
        createdBy,
      );
      await client.query('COMMIT');
      return snapshot;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertSnapshot(
    client: PoolClient,
    courseId: string,
    courseRevision: number,
    content: unknown,
    createdBy: string,
  ): Promise<CourseSnapshotRecord> {
    const result = await client.query<CourseSnapshotRecord>(
      `WITH inserted AS (
         INSERT INTO app.course_snapshots
           (course_id, course_revision, content, created_by)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (course_id, course_revision) DO NOTHING
         RETURNING id, course_id, course_revision, content, created_by, created_at
       )
       SELECT
         id,
         course_id AS "courseId",
         course_revision::integer AS "courseRevision",
         content,
         created_by AS "createdBy",
         created_at AS "createdAt"
       FROM inserted
       UNION ALL
       SELECT
         id,
         course_id AS "courseId",
         course_revision::integer AS "courseRevision",
         content,
         created_by AS "createdBy",
         created_at AS "createdAt"
       FROM app.course_snapshots
       WHERE course_id = $1 AND course_revision = $2
       LIMIT 1`,
      [courseId, courseRevision, JSON.stringify(content), createdBy],
    );
    return result.rows[0];
  }
}
