import type { Pool } from 'pg';

export interface BackgroundJob {
  id: string;
  type: string;
  ownerUserId: string;
  payload: unknown;
  attempts: number;
}

export class JobRepository {
  constructor(private readonly pool: Pool) {}

  async enqueue(input: {
    type: string;
    ownerUserId: string;
    payload?: unknown;
    resourceType?: string | null;
    resourceId?: string | null;
    sourceRevision?: string | null;
  }): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO app.background_jobs
        (type, owner_user_id, payload, resource_type, resource_id, source_revision)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)
       RETURNING id`,
      [
        input.type,
        input.ownerUserId,
        JSON.stringify(input.payload ?? {}),
        input.resourceType ?? null,
        input.resourceId ?? null,
        input.sourceRevision ?? null,
      ],
    );
    return result.rows[0].id;
  }

  async claimNext(workerId: string, type: string): Promise<BackgroundJob | null> {
    const result = await this.pool.query<BackgroundJob>(
      `WITH candidate AS (
         SELECT id
         FROM app.background_jobs
         WHERE status = 'queued' AND type = $2 AND run_after <= now()
         ORDER BY run_after, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE app.background_jobs job
       SET status = 'running',
           locked_by = $1,
           locked_until = now() + interval '5 minutes',
           attempts = attempts + 1,
           started_at = COALESCE(started_at, now()),
           updated_at = now()
       FROM candidate
       WHERE job.id = candidate.id
       RETURNING job.id, job.type, job.owner_user_id AS "ownerUserId",
                 job.payload, job.attempts`,
      [workerId, type],
    );
    return result.rows[0] ?? null;
  }

  async succeed(jobId: string, result: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE app.background_jobs
       SET status = 'succeeded', result = $2::jsonb, completed_at = now(),
           locked_by = NULL, locked_until = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running'`,
      [jobId, JSON.stringify(result)],
    );
  }

  async recordUsage(input: {
    eventKey?: string | null;
    userId?: string | null;
    requestId?: string | null;
    kind: string;
    source: string;
    provider?: string | null;
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    quantity?: number | null;
    unit?: string | null;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO app.usage_events
        (event_key, user_id, request_id, kind, source, provider, model,
         input_tokens, output_tokens, quantity, unit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (event_key) DO NOTHING`,
      [
        input.eventKey ?? null,
        input.userId ?? null,
        input.requestId ?? null,
        input.kind,
        input.source,
        input.provider ?? null,
        input.model ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.quantity ?? null,
        input.unit ?? null,
      ],
    );
    return result.rowCount === 1;
  }
}
