import { after, type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { requireAuthOrTeacher, rateLimitByUser } from '@/lib/server/api-guard';
import {
  cancelCourseRevoiceJob,
  createCourseRevoiceJob,
  getCourseRevoiceJob,
  runCourseRevoiceJob,
} from '@/lib/server/course-revoice-jobs';
import { getServiceSupabase } from '@/lib/supabase/server';
import type { StageTeacherVoiceConfig } from '@/lib/teacher/apply-teacher-voice';

export const runtime = 'nodejs';
export const maxDuration = 300;

async function ownedCourse(courseId: string, userId: string) {
  const service = getServiceSupabase();
  const { data, error } = await service
    .from('courses')
    .select('id, created_by, data, updated_at')
    .eq('id', courseId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.created_by !== userId) {
    const { data: profile, error: profileError } = await service
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    if (profileError) throw profileError;
    if (profile?.role !== 'admin') return 'forbidden' as const;
  }
  return data;
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrTeacher(['teacher', 'admin']);
  if (!auth.ok) return auth.response;
  const limit = rateLimitByUser(auth.user.id, 'course-revoice-start', 3, 60_000);
  if (!limit.ok) return limit.response;
  const { id } = await context.params;
  const course = await ownedCourse(id, auth.user.id);
  if (!course) return apiError('NOT_FOUND', 404, '课程不存在');
  if (course === 'forbidden') return apiError('FORBIDDEN', 403, '只有课程创建者可以更换音色');
  const body = (await request.json()) as { voice?: StageTeacherVoiceConfig };
  if (!body.voice?.providerId || !body.voice?.voiceId)
    return apiError('INVALID_REQUEST', 400, '音色参数无效');
  const data = course.data as {
    stage?: Record<string, unknown>;
    scenes?: Record<string, unknown>[];
    outlines?: unknown[];
  };
  if (!data.stage || !Array.isArray(data.scenes))
    return apiError('INVALID_REQUEST', 400, '课程内容不完整，无法重新配音');
  const job = await createCourseRevoiceJob({
    courseId: id,
    userId: auth.user.id,
    voice: body.voice,
    snapshot: {
      stage: data.stage,
      scenes: data.scenes,
      outlines: Array.isArray(data.outlines) ? data.outlines : [],
    },
    sourceUpdatedAt: course.updated_at,
  });
  after(() => runCourseRevoiceJob(job.id).catch(() => undefined));
  return apiSuccess({ job: present(job), pollIntervalMs: 5000 }, 202);
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrTeacher(['teacher', 'admin']);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const course = await ownedCourse(id, auth.user.id);
  if (!course) return apiError('NOT_FOUND', 404, '课程不存在');
  if (course === 'forbidden') return apiError('FORBIDDEN', 403, '无权查看该任务');
  const jobId = request.nextUrl.searchParams.get('jobId');
  const service = getServiceSupabase();
  const query = service
    .from('course_revoice_jobs')
    .select('*')
    .eq('course_id', id)
    .eq('requested_by', auth.user.id)
    .order('created_at', { ascending: false })
    .limit(1);
  const job = jobId
    ? await getCourseRevoiceJob(jobId, auth.user.id)
    : (await query.maybeSingle()).data;
  if (!job) return apiSuccess({ job: null });
  if (job.course_id !== id) return apiError('NOT_FOUND', 404, '任务不存在');
  if (job.status === 'queued') after(() => runCourseRevoiceJob(job.id).catch(() => undefined));
  return apiSuccess({ job: present(job), pollIntervalMs: 5000 });
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrTeacher(['teacher', 'admin']);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const jobId = request.nextUrl.searchParams.get('jobId');
  if (!jobId) return apiError('INVALID_REQUEST', 400, '缺少任务 ID');
  const course = await ownedCourse(id, auth.user.id);
  if (!course || course === 'forbidden') return apiError('NOT_FOUND', 404, '任务不存在');
  const job = await cancelCourseRevoiceJob(jobId, auth.user.id);
  if (!job || job.course_id !== id) return apiError('NOT_FOUND', 404, '任务不存在或已结束');
  return apiSuccess({ job: present(job) });
}

function present(job: {
  id: string;
  status: string;
  total_items: number;
  completed_items: number;
  failed_items: number;
  message: string;
  error?: string | null;
}) {
  return {
    id: job.id,
    status: job.status,
    total: job.total_items,
    completed: job.completed_items,
    failed: job.failed_items,
    message: job.message,
    error: job.error ?? undefined,
    done: ['succeeded', 'failed', 'cancelled', 'conflict'].includes(job.status),
  };
}
