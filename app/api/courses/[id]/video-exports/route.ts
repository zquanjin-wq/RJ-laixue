import type { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { requireAuthOrTeacher } from '@/lib/server/api-guard';
import {
  cancelCourseVideoExportJob,
  createCourseVideoDownloadUrl,
  createCourseVideoExportJob,
  getCourseVideoExportJob,
  startCourseVideoExportJob,
  syncCourseVideoExportJob,
  type CourseVideoExportJob,
} from '@/lib/server/course-video-export-jobs';
import { getServiceSupabase } from '@/lib/supabase/server';

export const runtime = 'nodejs';

async function canManageCourseVideoExport(courseId: string, userId: string) {
  const service = getServiceSupabase();
  const [{ data: course, error: courseError }, { data: profile, error: profileError }] = await Promise.all([
    service.from('courses').select('id, created_by').eq('id', courseId).maybeSingle(),
    service.from('profiles').select('role').eq('id', userId).maybeSingle(),
  ]);
  if (courseError || profileError) throw courseError ?? profileError;
  if (!course) return 'not_found' as const;
  return course.created_by === userId || profile?.role === 'admin' ? 'ok' as const : 'forbidden' as const;
}

function present(job: CourseVideoExportJob, downloadUrl?: string | null) {
  return {
    id: job.id,
    status: job.status,
    message: job.message,
    error: job.error ?? undefined,
    done: ['succeeded', 'failed', 'cancelled'].includes(job.status),
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    downloadUrl: downloadUrl ?? undefined,
  };
}

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrTeacher(['teacher', 'admin']);
  if (!auth.ok) return auth.response;
  const { id: courseId } = await context.params;
  const access = await canManageCourseVideoExport(courseId, auth.user.id);
  if (access === 'not_found') return apiError('NOT_FOUND', 404, '课程不存在');
  if (access === 'forbidden') return apiError('FORBIDDEN', 403, '只有课程创建者可以导出视频');

  try {
    const { job, upload } = await createCourseVideoExportJob(courseId, auth.user.id);
    return apiSuccess({ job: present(job), upload }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return apiError('INTERNAL_ERROR', 500, message);
  }
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrTeacher(['teacher', 'admin']);
  if (!auth.ok) return auth.response;
  const { id: courseId } = await context.params;
  const access = await canManageCourseVideoExport(courseId, auth.user.id);
  if (access !== 'ok') return apiError('NOT_FOUND', 404, '任务不存在');
  const jobId = request.nextUrl.searchParams.get('jobId');
  if (!jobId) return apiError('INVALID_REQUEST', 400, '缺少任务 ID');
  let job = await getCourseVideoExportJob(jobId);
  if (!job || job.course_id !== courseId) return apiError('NOT_FOUND', 404, '任务不存在');
  try {
    job = await syncCourseVideoExportJob(jobId);
    if (!job) return apiError('NOT_FOUND', 404, '任务不存在');
    const downloadUrl = await createCourseVideoDownloadUrl(job);
    return apiSuccess({ job: present(job, downloadUrl), pollIntervalMs: 3000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return apiError('INTERNAL_ERROR', 500, message);
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrTeacher(['teacher', 'admin']);
  if (!auth.ok) return auth.response;
  const { id: courseId } = await context.params;
  const access = await canManageCourseVideoExport(courseId, auth.user.id);
  if (access !== 'ok') return apiError('NOT_FOUND', 404, '任务不存在');
  const body = (await request.json().catch(() => null)) as { jobId?: string } | null;
  if (!body?.jobId) return apiError('INVALID_REQUEST', 400, '缺少任务 ID');
  const job = await getCourseVideoExportJob(body.jobId);
  if (!job || job.course_id !== courseId) return apiError('NOT_FOUND', 404, '任务不存在');
  try {
    const started = await startCourseVideoExportJob(job.id);
    if (!started) return apiError('NOT_FOUND', 404, '任务不存在');
    return apiSuccess({ job: present(started), pollIntervalMs: 3000 }, 202);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return apiError('INTERNAL_ERROR', 500, message);
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrTeacher(['teacher', 'admin']);
  if (!auth.ok) return auth.response;
  const { id: courseId } = await context.params;
  const access = await canManageCourseVideoExport(courseId, auth.user.id);
  if (access !== 'ok') return apiError('NOT_FOUND', 404, '任务不存在');
  const jobId = request.nextUrl.searchParams.get('jobId');
  if (!jobId) return apiError('INVALID_REQUEST', 400, '缺少任务 ID');
  const job = await getCourseVideoExportJob(jobId);
  if (!job || job.course_id !== courseId) return apiError('NOT_FOUND', 404, '任务不存在');
  const cancelled = await cancelCourseVideoExportJob(jobId);
  return apiSuccess({ job: cancelled ? present(cancelled) : present(job) });
}
