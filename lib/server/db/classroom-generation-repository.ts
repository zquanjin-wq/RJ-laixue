import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { CourseRepository } from './course-repository';
import type { Scene, Stage } from '@/lib/types/stage';

const JOB_TYPE = 'classroom-generation';

export class GenerationIdempotencyConflict extends Error {
  constructor() {
    super('Idempotency key already used for a different generation request');
    this.name = 'GenerationIdempotencyConflict';
  }
}

export class GenerationLeaseLost extends Error {
  constructor() {
    super('Generation execution no longer owns an active lease');
    this.name = 'GenerationLeaseLost';
  }
}

/** Hash the normalized JSON request, not transport headers or runtime secrets. */
export function generationRequestHash(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, normalize(v)]),
      );
    }
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(normalize(value)))
    .digest('hex');
}

export interface GenerationLease {
  id: string;
  workerId: string;
  epoch: number;
}

export interface ClaimedGeneration extends GenerationLease {
  ownerUserId: string;
  payload: unknown;
  courseId: string;
  operation: 'create' | 'enhance';
  pipelineKind: 'text_classroom' | 'pptx_ai_classroom';
  sourceRevision: number | null;
  configSnapshot: unknown;
  attempts: number;
}

/** Does not change how revoice/video and other existing queue consumers execute. */
export class ClassroomGenerationRepository {
  constructor(private readonly pool: Pool) {}

  async enqueue(input: {
    ownerUserId: string;
    operation: 'create' | 'enhance';
    channel: 'web' | 'skill';
    inputKind: 'text' | 'pptx';
    pipelineKind?: 'text_classroom' | 'pptx_ai_classroom';
    idempotencyKey: string;
    /** Validated, normalized input only; credentials must never be persisted here. */
    payload: unknown;
    configSnapshot?: unknown;
    courseId?: string;
    sourceRevision?: number;
  }): Promise<{ id: string; courseId: string; reused: boolean }> {
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200) {
      throw new Error('Invalid generation idempotency key');
    }
    if (
      input.operation === 'enhance' &&
      (!input.courseId || !Number.isInteger(input.sourceRevision) || input.sourceRevision! <= 0)
    ) {
      throw new Error('Enhancement requires courseId and a positive sourceRevision');
    }
    if (input.operation === 'create' && input.sourceRevision !== undefined) {
      throw new Error('Creation must not specify sourceRevision');
    }
    const requestHash = generationRequestHash({
      inputKind: input.inputKind,
      payload: input.payload,
      courseId: input.courseId,
      sourceRevision: input.sourceRevision,
    });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const id = randomUUID();
      const courseId = input.courseId ?? randomUUID();
      await client.query(
        `INSERT INTO app.background_jobs (id,type,owner_user_id,payload,resource_type,resource_id,source_revision)
         VALUES ($1,$2,$3,$4::jsonb,'course',$5,$6)`,
        [
          id,
          JOB_TYPE,
          input.ownerUserId,
          JSON.stringify(input.payload),
          courseId,
          input.sourceRevision ?? null,
        ],
      );
      const inserted = await client.query(
        `INSERT INTO app.classroom_generation_jobs
          (job_id,owner_user_id,operation,channel,input_kind,pipeline_kind,idempotency_key,request_hash,course_id,source_revision,config_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         ON CONFLICT (owner_user_id,operation,idempotency_key) DO NOTHING`,
        [
          id,
          input.ownerUserId,
          input.operation,
          input.channel,
          input.inputKind,
          input.pipelineKind ?? 'text_classroom',
          input.idempotencyKey,
          requestHash,
          courseId,
          input.sourceRevision ?? null,
          JSON.stringify(input.configSnapshot ?? {}),
        ],
      );
      if (inserted.rowCount === 1) {
        await client.query('COMMIT');
        return { id, courseId, reused: false };
      }
      // ON CONFLICT waits for the other transaction; this new statement sees its row.
      const existing = await client.query<{ id: string; courseId: string; requestHash: string }>(
        `SELECT job_id AS id,course_id AS "courseId",request_hash AS "requestHash"
         FROM app.classroom_generation_jobs WHERE owner_user_id=$1 AND operation=$2 AND idempotency_key=$3`,
        [input.ownerUserId, input.operation, input.idempotencyKey],
      );
      await client.query('ROLLBACK');
      const previous = existing.rows[0];
      if (!previous || previous.requestHash !== requestHash)
        throw new GenerationIdempotencyConflict();
      return { id: previous.id, courseId: previous.courseId, reused: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async claimNext(workerId: string): Promise<ClaimedGeneration | null> {
    // A crashed final attempt must become terminal, not remain running forever.
    await this.pool.query(
      `UPDATE app.background_jobs SET status='failed',error_code='ATTEMPTS_EXHAUSTED',
        completed_at=now(),updated_at=now(),locked_by=NULL,locked_until=NULL
       WHERE type=$1 AND attempts>=max_attempts
         AND (status='queued' OR (status='running' AND locked_until<=now()))`,
      [JOB_TYPE],
    );
    const result = await this.pool.query<ClaimedGeneration>(
      `WITH candidate AS (
         SELECT j.id FROM app.background_jobs j
         JOIN app.classroom_generation_jobs g ON g.job_id=j.id
         WHERE j.type=$2 AND j.attempts<j.max_attempts
           AND ((j.status='queued' AND j.run_after<=now()) OR (j.status='running' AND j.locked_until<=now()))
         ORDER BY j.run_after,j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1
       ), claimed AS (
         UPDATE app.background_jobs j SET status='running',locked_by=$1,
           locked_until=now()+interval '5 minutes',execution_epoch=execution_epoch+1,
           attempts=attempts+1,started_at=COALESCE(started_at,now()),updated_at=now()
         FROM candidate c WHERE j.id=c.id RETURNING j.*
       ) SELECT c.id,c.locked_by AS "workerId",c.execution_epoch AS epoch,
         c.owner_user_id AS "ownerUserId",c.payload,c.attempts,g.course_id AS "courseId",
         g.operation,g.pipeline_kind AS "pipelineKind",g.source_revision AS "sourceRevision",g.config_snapshot AS "configSnapshot"
         FROM claimed c JOIN app.classroom_generation_jobs g ON g.job_id=c.id`,
      [workerId, JOB_TYPE],
    );
    return result.rows[0] ?? null;
  }

  private async withLease<T>(
    lease: GenerationLease,
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT id FROM app.background_jobs WHERE id=$1 AND type=$4 AND status='running'
         AND locked_by=$2 AND execution_epoch=$3 AND locked_until>clock_timestamp() FOR UPDATE`,
        [lease.id, lease.workerId, lease.epoch, JOB_TYPE],
      );
      if (!current.rowCount) throw new GenerationLeaseLost();
      const result = await action(client);
      const expired = await client.query(
        `SELECT 1 FROM app.background_jobs WHERE id=$1 AND status='running' AND locked_until<=clock_timestamp()`,
        [lease.id],
      );
      if (expired.rowCount) throw new GenerationLeaseLost();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeat(lease: GenerationLease, progress: unknown): Promise<void> {
    await this.withLease(lease, async (client) => {
      await client.query(
        `UPDATE app.background_jobs SET locked_until=clock_timestamp()+interval '5 minutes',
         progress=$2::jsonb,updated_at=now() WHERE id=$1`,
        [lease.id, JSON.stringify(progress)],
      );
    });
  }

  async appendEvent(
    lease: GenerationLease,
    event: {
      kind: 'thinking' | 'tool' | 'result' | 'warning' | 'error';
      phase: string;
      page?: number;
      summary: string;
      details?: unknown;
    },
  ): Promise<void> {
    const summary = event.summary.trim();
    if (!summary || summary.length > 2000) throw new Error('Invalid generation event summary');
    await this.withLease(lease, async (client) => {
      await client.query(
        `INSERT INTO app.classroom_generation_events
          (job_id,execution_epoch,kind,phase,page,summary,details)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          lease.id,
          lease.epoch,
          event.kind,
          event.phase,
          event.page ?? null,
          summary,
          JSON.stringify(event.details ?? {}),
        ],
      );
    });
  }

  async saveStep(
    lease: GenerationLease,
    key: string,
    inputHash: string,
    artifact: unknown,
  ): Promise<void> {
    await this.withLease(lease, async (client) => {
      await client.query(
        `INSERT INTO app.classroom_generation_steps (job_id,step_key,input_hash,artifact,execution_epoch)
         VALUES ($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT (job_id,step_key) DO UPDATE SET input_hash=EXCLUDED.input_hash,
           artifact=EXCLUDED.artifact,execution_epoch=EXCLUDED.execution_epoch,completed_at=now()`,
        [lease.id, key, inputHash, JSON.stringify(artifact), lease.epoch],
      );
    });
  }

  async readStep<T>(lease: GenerationLease, key: string, inputHash: string): Promise<T | null> {
    return this.withLease(lease, async (client) => {
      const result = await client.query<{ artifact: T }>(
        `SELECT artifact FROM app.classroom_generation_steps WHERE job_id=$1 AND step_key=$2 AND input_hash=$3`,
        [lease.id, key, inputHash],
      );
      return result.rows[0]?.artifact ?? null;
    });
  }

  async fail(
    lease: GenerationLease,
    code: string,
    message: string,
    retryable: boolean,
  ): Promise<void> {
    await this.withLease(lease, async (client) => {
      await client.query(
        `UPDATE app.background_jobs SET
          status=CASE WHEN $4 AND attempts<max_attempts THEN 'queued' ELSE 'failed' END,
          run_after=now()+least(300,10*power(2,least(attempts-1,5))) * interval '1 second',
          completed_at=CASE WHEN $4 AND attempts<max_attempts THEN NULL ELSE now() END,
          error_code=$2,error_message=$3,locked_by=NULL,locked_until=NULL,updated_at=now()
         WHERE id=$1`,
        [lease.id, code, message, retryable],
      );
    });
  }

  async cancel(id: string, ownerUserId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE app.background_jobs SET status='cancelled',completed_at=now(),updated_at=now(),
        locked_by=NULL,locked_until=NULL WHERE id=$1 AND owner_user_id=$2 AND type=$3 AND status IN ('queued','running')`,
      [id, ownerUserId, JOB_TYPE],
    );
    return result.rowCount === 1;
  }

  /**
   * Restart a terminal generation against the same immutable request. Completed
   * checkpoints remain available, so a retry resumes from the first missing or
   * invalidated step instead of re-parsing the PPTX or re-synthesizing audio.
   */
  async retry(id: string, ownerUserId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query<{
        status: string;
        pipelineKind: string;
        courseRevision: number | null;
        sourceMatches: boolean;
      }>(
        `SELECT j.status,g.pipeline_kind AS "pipelineKind",
          c.content_revision::integer AS "courseRevision",
          COALESCE(c.content->'stage'->'pptxSource'->>'sourceId'=j.payload->>'sourceId',false) AS "sourceMatches"
         FROM app.background_jobs j
         JOIN app.classroom_generation_jobs g ON g.job_id=j.id
         LEFT JOIN app.courses c ON c.id=g.course_id AND c.deleted_at IS NULL
         WHERE j.id=$1 AND j.owner_user_id=$2 AND j.type=$3
         FOR UPDATE OF j,g`,
        [id, ownerUserId, JOB_TYPE],
      );
      const job = target.rows[0];
      if (!job || !['failed', 'cancelled', 'conflict'].includes(job.status)) {
        await client.query('ROLLBACK');
        return false;
      }
      if (job.status === 'conflict' && job.pipelineKind === 'pptx_ai_classroom') {
        if (!job.courseRevision || !job.sourceMatches) {
          await client.query('ROLLBACK');
          return false;
        }
        // Rebase only onto the same immutable PPTX source. The worker reads the
        // current canvas, so genuine teacher edits remain intact while the
        // generated actions/audio are added to the new revision.
        await client.query(
          `UPDATE app.classroom_generation_jobs SET source_revision=$3 WHERE job_id=$1 AND owner_user_id=$2`,
          [id, ownerUserId, job.courseRevision],
        );
        await client.query(`UPDATE app.background_jobs SET source_revision=$2 WHERE id=$1`, [
          id,
          job.courseRevision,
        ]);
      }
      const result = await client.query(
        `UPDATE app.background_jobs SET status='queued',attempts=0,run_after=now(),
          started_at=NULL,completed_at=NULL,error_code=NULL,error_message=NULL,
          result=NULL,progress='{"step":"queued","progress":0}'::jsonb,
          locked_by=NULL,locked_until=NULL,execution_epoch=execution_epoch+1,updated_at=now()
         WHERE id=$1 AND owner_user_id=$2 AND type=$3`,
        [id, ownerUserId, JOB_TYPE],
      );
      await client.query('COMMIT');
      return result.rowCount === 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getOwned(id: string, ownerUserId: string) {
    const result = await this.pool.query<{
      id: string;
      status: string;
      progress: unknown;
      result: unknown;
      errorCode: string | null;
      errorMessage: string | null;
      courseId: string;
      createdAt: Date;
      completedAt: Date | null;
    }>(
      `SELECT j.id,j.status,j.progress,j.result,j.error_code AS "errorCode",
       j.error_message AS "errorMessage",
       g.course_id AS "courseId",j.created_at AS "createdAt",j.completed_at AS "completedAt"
       FROM app.background_jobs j JOIN app.classroom_generation_jobs g ON g.job_id=j.id
       WHERE j.id=$1 AND j.owner_user_id=$2 AND j.type=$3`,
      [id, ownerUserId, JOB_TYPE],
    );
    return result.rows[0] ?? null;
  }

  async listOwnedEvents(id: string, ownerUserId: string, afterId = 0) {
    const result = await this.pool.query<{
      id: string;
      kind: 'thinking' | 'tool' | 'result' | 'warning' | 'error';
      phase: string;
      page: number | null;
      summary: string;
      details: unknown;
      createdAt: Date;
    }>(
      `SELECT e.id,e.kind,e.phase,e.page,e.summary,e.details,e.created_at AS "createdAt"
       FROM app.classroom_generation_events e
       JOIN app.classroom_generation_jobs g ON g.job_id=e.job_id
       JOIN app.background_jobs j ON j.id=e.job_id
       WHERE e.job_id=$1 AND g.owner_user_id=$2 AND e.execution_epoch=j.execution_epoch AND e.id>$3
       ORDER BY e.id ASC LIMIT 200`,
      [id, ownerUserId, Math.max(0, afterId)],
    );
    return result.rows;
  }

  /** Course write and terminal job result share one transaction; no JSON dual write. */
  async commitCourse(
    lease: GenerationLease,
    draft: {
      stage: Stage;
      scenes: Scene[];
      outlines?: unknown[];
      warnings?: string[];
      assetIds?: string[];
    },
  ): Promise<{ status: 'succeeded'; courseId: string; revision: number } | { status: 'conflict' }> {
    return this.withLease(lease, async (client) => {
      const metadata = await client.query<{
        ownerUserId: string;
        courseId: string;
        operation: 'create' | 'enhance';
        sourceRevision: number | null;
      }>(
        `SELECT owner_user_id AS "ownerUserId",course_id AS "courseId",operation,source_revision AS "sourceRevision"
         FROM app.classroom_generation_jobs WHERE job_id=$1`,
        [lease.id],
      );
      const job = metadata.rows[0];
      if (!job || draft.stage.id !== job.courseId || draft.scenes.length === 0) {
        throw new Error('Invalid generation course draft');
      }
      // Lock both records so demotion/banning serializes with this commit.
      const actor = await client.query<{ role: string }>(
        `SELECT p.role FROM app.user_profiles p JOIN public."user" u ON u.id=p.user_id
         WHERE p.user_id=$1 AND u.banned IS NOT TRUE AND p.role IN ('teacher','admin') FOR SHARE OF p,u`,
        [job.ownerUserId],
      );
      if (!actor.rowCount) throw new Error('Generation owner can no longer create courses');
      const current = await client.query<{
        ownerUserId: string;
        revision: number;
        deletedAt: Date | null;
      }>(
        `SELECT owner_user_id AS "ownerUserId",content_revision::integer AS revision,deleted_at AS "deletedAt"
         FROM app.courses WHERE id=$1 FOR UPDATE`,
        [job.courseId],
      );
      const existing = current.rows[0];
      if (existing && existing.ownerUserId !== job.ownerUserId && actor.rows[0].role !== 'admin') {
        throw new Error('Generation owner can no longer manage this course');
      }
      const conflict = async () => {
        const changed = await client.query(
          `UPDATE app.background_jobs SET status='conflict',error_code='COURSE_REVISION_CONFLICT',
           completed_at=now(),updated_at=now(),locked_by=NULL,locked_until=NULL WHERE id=$1 AND locked_until>clock_timestamp()`,
          [lease.id],
        );
        if (!changed.rowCount) throw new GenerationLeaseLost();
        return { status: 'conflict' as const };
      };
      if (
        job.operation === 'create'
          ? !!existing
          : !existing || !!existing.deletedAt || existing.revision !== job.sourceRevision
      ) {
        return conflict();
      }
      const assetIds = [...new Set(draft.assetIds ?? [])].sort();
      if (assetIds.length) {
        const assets = await client.query(
          `SELECT id FROM app.course_assets WHERE id=ANY($1::uuid[]) AND owner_user_id=$2
           AND (course_id IS NULL OR course_id=$3) AND state='ready' AND deleted_at IS NULL
           ORDER BY id FOR UPDATE`,
          [assetIds, job.ownerUserId, job.courseId],
        );
        if (assets.rowCount !== assetIds.length)
          throw new Error('Generation assets are not confirmed or owned');
      }
      const content = {
        stage: draft.stage,
        scenes: draft.scenes,
        outlines: draft.outlines ?? [],
        saveState: 'draft',
        generation: {
          jobId: lease.id,
          quality: draft.warnings?.length ? 'needs_review' : 'complete',
          warnings: draft.warnings ?? [],
        },
      };
      const courses = new CourseRepository(this.pool);
      const course =
        job.operation === 'create'
          ? await courses.createCourse(
              {
                id: job.courseId,
                ownerUserId: job.ownerUserId,
                title: draft.stage.name,
                content,
                saveState: 'draft',
              },
              client,
            )
          : await courses.updateCourse(
              {
                id: job.courseId,
                ownerUserId: existing.ownerUserId,
                expectedRevision: job.sourceRevision!,
                title: draft.stage.name,
                content,
                saveState: 'draft',
              },
              client,
            );
      if (!course) return conflict();
      if (assetIds.length) {
        await client.query(
          `UPDATE app.course_assets SET course_id=$2,bound_at=COALESCE(bound_at,now()) WHERE id=ANY($1::uuid[])`,
          [assetIds, job.courseId],
        );
      }
      const result = {
        status: 'succeeded' as const,
        courseId: job.courseId,
        revision: course.contentRevision,
      };
      // Recheck time after any waits for course/permission/asset locks. Roll back the entire draft if expired.
      const completed = await client.query(
        `UPDATE app.background_jobs SET status='succeeded',result=$2::jsonb,
         progress='{"step":"completed","progress":100}'::jsonb,completed_at=now(),updated_at=now(),
         error_code=NULL,error_message=NULL,locked_by=NULL,locked_until=NULL
         WHERE id=$1 AND locked_until>clock_timestamp()`,
        [lease.id, JSON.stringify(result)],
      );
      if (!completed.rowCount) throw new GenerationLeaseLost();
      return result;
    });
  }
}
