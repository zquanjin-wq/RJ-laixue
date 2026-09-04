import { after, type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { requireAuthOrTeacher, rateLimitByUser } from '@/lib/server/api-guard';
import { AccessRepository } from '@/lib/server/db/access-repository';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { getDatabasePool } from '@/lib/server/db/pool';
import { cancelCourseRevoiceJob, createCourseRevoiceJob, getCourseRevoiceJob, getLatestCourseRevoiceJob, runCourseRevoiceJob, assertServerRevoiceVoice, describeCourseRevoiceError, isRevoiceNoopError } from '@/lib/server/course-revoice-jobs';
import type { StageTeacherVoiceConfig } from '@/lib/teacher/apply-teacher-voice';

export const runtime = 'nodejs';
export const maxDuration = 300;

async function ownedCourse(courseId: string, userId: string) {
  const pool = getDatabasePool();
  const course = await new CourseRepository(pool).getCourse(courseId);
  if (!course) return null;
  const actor = await new AccessRepository(pool).resolveActor(userId);
  if (!actor || !(await new AccessRepository(pool).canManageCourse(actor, courseId))) return 'forbidden' as const;
  return course;
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrTeacher(['teacher', 'admin']);
  if (!auth.ok) return auth.response;
  const limit = rateLimitByUser(auth.user.id, 'course-revoice-start', 3, 60_000);
  if (!limit.ok) return limit.response;
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as { voice?: StageTeacherVoiceConfig } | null;
  if (!body?.voice?.providerId || !body.voice?.voiceId) return apiError('INVALID_REQUEST', 400, '请选择有效的 AI 教师音色。');
  try { assertServerRevoiceVoice(body.voice); } catch (error) { const failure = describeCourseRevoiceError(error); return apiError(failure.code, failure.status, failure.message); }
  const course = await ownedCourse(id, auth.user.id);
  if (course === 'forbidden') return apiError('NOT_FOUND', 404, 'Course not found.');
  if (!course) return apiError('NOT_FOUND', 404, 'Course not found.');
  const data = course.content as { stage?: Record<string, unknown>; scenes?: Record<string, unknown>[]; outlines?: unknown[] };
  if (!data.stage || !Array.isArray(data.scenes)) return apiError('INVALID_REQUEST', 400, 'Course content is incomplete.');
  try {
    const job = await createCourseRevoiceJob({ courseId: id, userId: auth.user.id, voice: body.voice, snapshot: { stage: data.stage, scenes: data.scenes, outlines: Array.isArray(data.outlines) ? data.outlines : [] }, sourceUpdatedAt: course.updatedAt.toISOString() });
    after(() => runCourseRevoiceJob(job.id).catch(() => undefined));
    return apiSuccess({ job: present(job), pollIntervalMs: 5000 }, job.status === 'queued' ? 202 : 200);
  } catch (error) {
    if (isRevoiceNoopError(error)) return apiSuccess({ job: { id: `noop-${id}`, status: 'succeeded', total: 0, completed: 0, failed: 0, message: error instanceof Error ? error.message : 'No changes required.', voice: body.voice, done: true }, pollIntervalMs: 0 });
    const failure = describeCourseRevoiceError(error);
    console.error('[course-revoice] create job failed', { code: failure.code, message: error instanceof Error ? error.message : 'Unknown error' });
    return apiError(failure.code, failure.status, failure.message);
  }
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrTeacher(['teacher', 'admin']);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const course = await ownedCourse(id, auth.user.id);
  if (!course || course === 'forbidden') return apiError('NOT_FOUND', 404, 'Course not found.');
  const jobId = request.nextUrl.searchParams.get('jobId');
  const job = jobId ? await getCourseRevoiceJob(jobId) : await getLatestCourseRevoiceJob(id);
  if (!job || job.course_id !== id) return apiSuccess({ job: null });
  if (job.status === 'queued' || job.status === 'running') after(() => runCourseRevoiceJob(job.id).catch(() => undefined));
  return apiSuccess({ job: present(job), pollIntervalMs: 5000 });
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrTeacher(['teacher', 'admin']);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const jobId = request.nextUrl.searchParams.get('jobId');
  if (!jobId) return apiError('INVALID_REQUEST', 400, 'Missing job ID.');
  const course = await ownedCourse(id, auth.user.id);
  if (!course || course === 'forbidden') return apiError('NOT_FOUND', 404, 'Job not found.');
  const existingJob = await getCourseRevoiceJob(jobId);
  if (!existingJob || existingJob.course_id !== id) return apiError('NOT_FOUND', 404, 'Job not found.');
  const job = await cancelCourseRevoiceJob(jobId, id);
  if (!job) return apiError('NOT_FOUND', 404, 'Job not found.');
  return apiSuccess({ job: present(job) });
}

function present(job: { id: string; status: string; total_items: number; completed_items: number; failed_items: number; message: string; error?: string | null; voice: StageTeacherVoiceConfig }) {
  return { id: job.id, status: job.status, total: job.total_items, completed: job.completed_items, failed: job.failed_items, message: job.message, error: job.error ?? undefined, voice: job.voice, done: ['succeeded', 'failed', 'cancelled', 'conflict'].includes(job.status) };
}
