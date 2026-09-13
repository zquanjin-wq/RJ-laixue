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

/**
 * Course management only needs this metadata. Keeping `content` out of list
 * queries avoids detoasting and serializing complete slide decks (including
 * page images and generated audio references) before the list can render.
 */
export type CourseListRecord = Omit<CourseRecord, 'content'> & {
  generationJobId: string | null;
  generationStatus: string | null;
  generationProgress: unknown;
  generationErrorCode: string | null;
  generationErrorMessage: string | null;
};

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

const courseListColumns = `
  c.id,
  c.owner_user_id AS "ownerUserId",
  c.title,
  c.topic,
  c.save_state AS "saveState",
  c.content_revision::integer AS "contentRevision",
  c.created_at AS "createdAt",
  c.updated_at AS "updatedAt",
  generation.id AS "generationJobId",
  generation.status AS "generationStatus",
  generation.progress AS "generationProgress",
  generation.error_code AS "generationErrorCode",
  generation.error_message AS "generationErrorMessage"
`;

const latestGenerationJoin = `
  LEFT JOIN LATERAL (
    SELECT j.id,j.status,j.progress,j.error_code,j.error_message
    FROM app.classroom_generation_jobs g
    JOIN app.background_jobs j ON j.id=g.job_id
    WHERE g.course_id=c.id AND g.pipeline_kind='pptx_ai_classroom'
    ORDER BY j.created_at DESC
    LIMIT 1
  ) generation ON true
`;

export class CourseRepository {
  constructor(private readonly pool: Pool) {}

  async createCourse(
    input: {
      id: string;
      ownerUserId: string;
      title: string;
      topic?: string | null;
      content: unknown;
      saveState?: CourseSaveState;
    },
    transaction?: PoolClient,
  ): Promise<CourseRecord> {
    const result = await (transaction ?? this.pool).query<CourseRecord>(
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

  async listOwnedCourses(ownerUserId: string): Promise<CourseListRecord[]> {
    const result = await this.pool.query<CourseListRecord>(
      `SELECT ${courseListColumns}
       FROM app.courses c
       ${latestGenerationJoin}
       WHERE c.owner_user_id = $1 AND c.deleted_at IS NULL
       ORDER BY c.updated_at DESC, c.id`,
      [ownerUserId],
    );
    return result.rows;
  }

  async listCourses(): Promise<CourseListRecord[]> {
    const result = await this.pool.query<CourseListRecord>(
      `SELECT ${courseListColumns}
       FROM app.courses c
       ${latestGenerationJoin}
       WHERE c.deleted_at IS NULL
       ORDER BY c.updated_at DESC, c.id`,
    );
    return result.rows;
  }

  async updateCourse(
    input: {
      id: string;
      ownerUserId: string;
      expectedRevision: number;
      title: string;
      topic?: string | null;
      content: unknown;
      saveState: CourseSaveState;
    },
    transaction?: PoolClient,
  ): Promise<CourseRecord | null> {
    const result = await (transaction ?? this.pool).query<CourseRecord>(
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
         AND (
           title IS DISTINCT FROM $4
           OR topic IS DISTINCT FROM $5
           OR content IS DISTINCT FROM $6::jsonb
           OR save_state IS DISTINCT FROM $7
         )
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
    if (result.rows[0]) return result.rows[0];

    // Autosave is allowed to send the same snapshot more than once. Treat an
    // identical save at the current revision as a successful no-op: creating a
    // new revision would unnecessarily invalidate the current video export and
    // make an in-flight revoice job conflict with unchanged course content.
    const unchanged = await (transaction ?? this.pool).query<CourseRecord>(
      `SELECT ${courseColumns}
       FROM app.courses
       WHERE id = $1
         AND owner_user_id = $2
         AND content_revision = $3
         AND deleted_at IS NULL
         AND title IS NOT DISTINCT FROM $4
         AND topic IS NOT DISTINCT FROM $5
         AND content IS NOT DISTINCT FROM $6::jsonb
         AND save_state IS NOT DISTINCT FROM $7`,
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
    return unchanged.rows[0] ?? null;
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
        'pending',
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

  async markAssetReady(objectKey: string, ownerUserId: string): Promise<CourseAssetRecord | null> {
    const result = await this.pool.query<CourseAssetRecord>(
      `UPDATE app.course_assets
       SET state='ready', bound_at=CASE WHEN course_id IS NULL THEN bound_at ELSE COALESCE(bound_at,now()) END
       WHERE object_key=$1 AND owner_user_id=$2 AND state='pending' AND deleted_at IS NULL
       RETURNING id,course_id AS "courseId",owner_user_id AS "ownerUserId",kind,
         object_key AS "objectKey",content_type AS "contentType",size_bytes::double precision AS "sizeBytes",
         state,created_at AS "createdAt",bound_at AS "boundAt"`,
      [objectKey, ownerUserId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Finds upload records that were never bound to a course, then atomically
   * leases them for cleanup. Bound assets are deliberately excluded: they may
   * still be part of a durable generation task and must never be reclaimed by
   * this maintenance path.
   */
  async claimStaleUnboundPendingAssets(cutoff: Date, limit: number): Promise<CourseAssetRecord[]> {
    const result = await this.pool.query<CourseAssetRecord>(
      `WITH candidates AS (
         SELECT id
         FROM app.course_assets
         WHERE state = 'pending'
           AND course_id IS NULL
           AND deleted_at IS NULL
           AND created_at < $1
         ORDER BY created_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE app.course_assets asset
       SET state = 'deleting'
       FROM candidates
       WHERE asset.id = candidates.id
       RETURNING asset.id,
         asset.course_id AS "courseId",
         asset.owner_user_id AS "ownerUserId",
         asset.kind,
         asset.object_key AS "objectKey",
         asset.content_type AS "contentType",
         asset.size_bytes::double precision AS "sizeBytes",
         asset.state,
         asset.created_at AS "createdAt",
         asset.bound_at AS "boundAt"`,
      [cutoff, limit],
    );
    return result.rows;
  }

  async completeAssetDeletion(assetId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE app.course_assets
       SET state = 'deleted', deleted_at = now()
       WHERE id = $1 AND state = 'deleting' AND deleted_at IS NULL`,
      [assetId],
    );
    return result.rowCount === 1;
  }

  async failAssetDeletion(assetId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE app.course_assets
       SET state = 'failed'
       WHERE id = $1 AND state = 'deleting' AND deleted_at IS NULL`,
      [assetId],
    );
    return result.rowCount === 1;
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
