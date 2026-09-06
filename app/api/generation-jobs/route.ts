import { NextRequest, NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { getDatabasePool } from '@/lib/server/db/pool';
import {
  ClassroomGenerationRepository,
  GenerationIdempotencyConflict,
} from '@/lib/server/db/classroom-generation-repository';
import {
  generationRequestSchema,
  TEXT_GENERATION_PIPELINE_VERSION,
} from '@/lib/server/generation-request';
import { resolveModel } from '@/lib/server/resolve-model';
import { rateLimitByUser } from '@/lib/server/api-guard';

export const runtime = 'nodejs';

/** Opt-in during local integration; the legacy public entry is not cut over yet. */
export async function POST(request: NextRequest) {
  if (process.env.CLASSROOM_GENERATION_ENABLED !== 'true') {
    return NextResponse.json({ errorCode: 'GENERATION_NOT_ENABLED' }, { status: 503 });
  }
  const actor = await getCurrentActor();
  if (!actor) return NextResponse.json({ errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  if (actor.role === 'learner')
    return NextResponse.json({ errorCode: 'FORBIDDEN' }, { status: 403 });
  const key = request.headers.get('idempotency-key');
  if (!key?.trim() || key.length > 200) {
    return NextResponse.json({ errorCode: 'INVALID_IDEMPOTENCY_KEY' }, { status: 400 });
  }
  const body = generationRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ errorCode: 'INVALID_REQUEST' }, { status: 400 });
  const limit = rateLimitByUser(actor.userId, 'generation-jobs', 5, 60_000);
  if (!limit.ok) return limit.response;
  try {
    const resolved = await resolveModel({ stage: 'generate-classroom' });
    const job = await new ClassroomGenerationRepository(getDatabasePool()).enqueue({
      ownerUserId: actor.userId,
      operation: 'create',
      channel: 'web',
      inputKind: 'text',
      idempotencyKey: key,
      payload: body.data,
      configSnapshot: {
        pipelineVersion: TEXT_GENERATION_PIPELINE_VERSION,
        model: { modelString: resolved.modelString, thinkingConfig: resolved.thinkingConfig },
      },
    });
    return NextResponse.json(
      {
        jobId: job.id,
        courseId: job.courseId,
        reused: job.reused,
        pollUrl: `/api/generation-jobs/${job.id}`,
        pollIntervalMs: 5000,
      },
      { status: 202 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        errorCode:
          error instanceof GenerationIdempotencyConflict
            ? 'IDEMPOTENCY_CONFLICT'
            : 'GENERATION_UNAVAILABLE',
      },
      { status: error instanceof GenerationIdempotencyConflict ? 409 : 503 },
    );
  }
}
