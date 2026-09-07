import { NextRequest, NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { getDatabasePool } from '@/lib/server/db/pool';
import {
  ClassroomGenerationRepository,
  GenerationIdempotencyConflict,
} from '@/lib/server/db/classroom-generation-repository';
import {
  generationRequestSchema,
  PPTX_AI_CLASSROOM_PIPELINE_VERSION,
  pptxAiClassroomRequestSchema,
  TEXT_GENERATION_PIPELINE_VERSION,
} from '@/lib/server/generation-request';
import { resolveModel } from '@/lib/server/resolve-model';
import { rateLimitByUser } from '@/lib/server/api-guard';
import { PptxSourceRepository } from '@/lib/server/db/pptx-source-repository';
import { CourseRepository } from '@/lib/server/db/course-repository';

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
  const rawBody = await request.json().catch(() => null);
  const parsedPptx = pptxAiClassroomRequestSchema.safeParse(rawBody);
  const pptx = parsedPptx.success ? parsedPptx.data : null;
  const parsedText = pptx ? null : generationRequestSchema.safeParse(rawBody);
  const text = parsedText?.success ? parsedText.data : null;
  if (!pptx && !text)
    return NextResponse.json({ errorCode: 'INVALID_REQUEST' }, { status: 400 });
  if (pptx && process.env.PPTX_AI_CLASSROOM_ENABLED !== 'true') {
    return NextResponse.json({ errorCode: 'PPTX_AI_CLASSROOM_NOT_ENABLED' }, { status: 503 });
  }
  const limit = rateLimitByUser(actor.userId, 'generation-jobs', 5, 60_000);
  if (!limit.ok) return limit.response;
  try {
    const resolved = await resolveModel({ stage: 'generate-classroom' });
    const pool = getDatabasePool();
    if (pptx) {
      const source = await new PptxSourceRepository(pool).getOwned(pptx.sourceId, actor.userId);
      const course = await new CourseRepository(pool).getCourse(pptx.courseId);
      if (!source || !course || course.ownerUserId !== actor.userId)
        return NextResponse.json({ errorCode: 'SOURCE_OR_COURSE_NOT_FOUND' }, { status: 404 });
      const stage =
        course.content && typeof course.content === 'object'
          ? (course.content as { stage?: { pptxSource?: { sourceId?: unknown } } }).stage
          : undefined;
      if (stage?.pptxSource?.sourceId !== pptx.sourceId)
        return NextResponse.json({ errorCode: 'SOURCE_COURSE_MISMATCH' }, { status: 409 });
      if (course.contentRevision !== pptx.sourceRevision)
        return NextResponse.json({
          errorCode: 'COURSE_REVISION_CONFLICT',
          currentRevision: course.contentRevision,
        }, { status: 409 });
    }
    const job = await new ClassroomGenerationRepository(pool).enqueue({
      ownerUserId: actor.userId,
      operation: pptx ? 'enhance' : 'create',
      channel: 'web',
      inputKind: pptx ? 'pptx' : 'text',
      pipelineKind: pptx ? 'pptx_ai_classroom' : 'text_classroom',
      idempotencyKey: key,
      payload: pptx ?? text,
      ...(pptx
        ? { courseId: pptx.courseId, sourceRevision: pptx.sourceRevision }
        : {}),
      configSnapshot: {
        pipelineVersion: pptx
          ? PPTX_AI_CLASSROOM_PIPELINE_VERSION
          : TEXT_GENERATION_PIPELINE_VERSION,
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
