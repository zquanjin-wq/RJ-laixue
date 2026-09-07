import { NextRequest, NextResponse } from 'next/server';
import { getDatabasePool } from '@/lib/server/db/pool';
import { resolveApiToken } from '@/lib/server/api-token';
import { ClassroomGenerationRepository, GenerationIdempotencyConflict } from '@/lib/server/db/classroom-generation-repository';
import { PptxSourceRepository } from '@/lib/server/db/pptx-source-repository';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { pptxAiClassroomRequestSchema, PPTX_AI_CLASSROOM_PIPELINE_VERSION } from '@/lib/server/generation-request';
import { resolveModel } from '@/lib/server/resolve-model';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  if (process.env.PPTX_AI_CLASSROOM_ENABLED !== 'true') return NextResponse.json({ errorCode: 'NOT_AVAILABLE' }, { status: 503 });
  const pool = getDatabasePool();
  const actor = await resolveApiToken(pool, request.headers.get('authorization'));
  if (!actor || actor.role === 'learner' || !actor.scopes.includes('classroom:write')) return NextResponse.json({ errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  const key = request.headers.get('idempotency-key');
  if (!key?.trim() || key.length > 200) return NextResponse.json({ errorCode: 'INVALID_IDEMPOTENCY_KEY' }, { status: 400 });
  const parsed = pptxAiClassroomRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ errorCode: 'INVALID_REQUEST' }, { status: 400 });
  const input = parsed.data;
  const source = await new PptxSourceRepository(pool).getOwned(input.sourceId, actor.userId);
  const course = await new CourseRepository(pool).getCourse(input.courseId);
  if (!source || !course || course.ownerUserId !== actor.userId || course.contentRevision !== input.sourceRevision) return NextResponse.json({ errorCode: 'SOURCE_OR_COURSE_NOT_FOUND' }, { status: 404 });
  try {
    const model = await resolveModel({ stage: 'generate-classroom' });
    const job = await new ClassroomGenerationRepository(pool).enqueue({ ownerUserId: actor.userId, operation: 'enhance', channel: 'skill', inputKind: 'pptx', pipelineKind: 'pptx_ai_classroom', idempotencyKey: key, payload: input, courseId: input.courseId, sourceRevision: input.sourceRevision, configSnapshot: { pipelineVersion: PPTX_AI_CLASSROOM_PIPELINE_VERSION, model: { modelString: model.modelString, thinkingConfig: model.thinkingConfig } } });
    return NextResponse.json({ jobId: job.id, courseId: job.courseId, pollUrl: `/api/v1/pptx-classrooms/${job.id}` }, { status: 202 });
  } catch (error) { return NextResponse.json({ errorCode: error instanceof GenerationIdempotencyConflict ? 'IDEMPOTENCY_CONFLICT' : 'GENERATION_UNAVAILABLE' }, { status: error instanceof GenerationIdempotencyConflict ? 409 : 503 }); }
}
