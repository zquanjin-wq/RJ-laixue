import { nanoid } from 'nanoid';
import { COURSE_ASSET_BUCKET } from '@/lib/course-assets/shared';
import { getServiceSupabase } from '@/lib/supabase/server';

export type CourseVideoExportStatus =
  | 'uploading'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface CourseVideoExportJob {
  id: string;
  course_id: string;
  requested_by: string;
  status: CourseVideoExportStatus;
  input_path: string;
  output_path?: string | null;
  render_job_id?: string | null;
  message: string;
  error?: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  updated_at: string;
}

type RenderStatus = {
  status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  error?: string;
  frame?: number;
  totalFrames?: number;
};

function renderServiceUrl() {
  const value = process.env.VIDEO_RENDER_SERVICE_URL?.trim().replace(/\/$/, '');
  if (!value) throw new Error('视频渲染服务尚未配置');
  return value;
}

async function readJson<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${operation}失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
  }
  return response.json() as Promise<T>;
}

function jobPaths(courseId: string, jobId: string) {
  const base = `courses/${courseId}/video-exports/${jobId}`;
  return { inputPath: `${base}/source.zip`, outputPath: `${base}/course.mp4` };
}

export async function createCourseVideoExportJob(courseId: string, userId: string) {
  const id = nanoid(16);
  const { inputPath, outputPath } = jobPaths(courseId, id);
  const service = getServiceSupabase();
  const job = {
    id,
    course_id: courseId,
    requested_by: userId,
    status: 'uploading' as const,
    input_path: inputPath,
    output_path: outputPath,
    message: '正在准备视频导出文件',
  };
  const { data: created, error } = await service
    .from('course_video_export_jobs')
    .insert(job)
    .select('*')
    .single();
  if (error || !created) throw new Error(`创建视频导出任务失败：${error?.message ?? 'unknown'}`);
  const { data, error: uploadError } = await service.storage
    .from(COURSE_ASSET_BUCKET)
    .createSignedUploadUrl(inputPath, { upsert: true });
  if (uploadError || !data) throw new Error(`创建视频导出上传地址失败：${uploadError?.message ?? 'unknown'}`);
  return { job: created as CourseVideoExportJob, upload: data };
}

export async function getCourseVideoExportJob(jobId: string) {
  const { data, error } = await getServiceSupabase()
    .from('course_video_export_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw error;
  return data as CourseVideoExportJob | null;
}

export async function startCourseVideoExportJob(jobId: string) {
  const service = getServiceSupabase();
  const job = await getCourseVideoExportJob(jobId);
  if (!job) return null;
  if (job.render_job_id || ['running', 'succeeded'].includes(job.status)) return job;
  if (job.status !== 'uploading' && job.status !== 'queued') return job;

  const { data: source, error: downloadError } = await service.storage
    .from(COURSE_ASSET_BUCKET)
    .download(job.input_path);
  if (downloadError || !source) {
    throw new Error(`读取视频导出文件失败：${downloadError?.message ?? '文件不存在'}`);
  }

  const form = new FormData();
  form.append('project', source, 'course.zip');
  form.append('fps', '24');
  form.append('quality', 'draft');
  form.append('format', 'mp4');
  const submitted = await readJson<{ jobId?: string }>(
    await fetch(`${renderServiceUrl()}/render`, { method: 'POST', body: form }),
    '提交视频渲染任务',
  );
  if (!submitted.jobId) throw new Error('渲染服务未返回任务 ID');

  const now = new Date().toISOString();
  const { data, error } = await service
    .from('course_video_export_jobs')
    .update({
      status: 'running',
      render_job_id: submitted.jobId,
      message: '正在生成课程视频',
      started_at: now,
      updated_at: now,
    })
    .eq('id', jobId)
    .select('*')
    .single();
  if (error) throw error;
  return data as CourseVideoExportJob;
}

export async function syncCourseVideoExportJob(jobId: string) {
  const service = getServiceSupabase();
  const job = await getCourseVideoExportJob(jobId);
  if (!job || job.status !== 'running' || !job.render_job_id) return job;

  const render = await readJson<RenderStatus>(
    await fetch(`${renderServiceUrl()}/render/${encodeURIComponent(job.render_job_id)}`),
    '查询视频渲染状态',
  );
  if (render.status === 'queued' || render.status === 'running') {
    const progress = render.totalFrames && typeof render.frame === 'number'
      ? `（${render.frame}/${render.totalFrames} 帧）`
      : '';
    const { data, error } = await service
      .from('course_video_export_jobs')
      .update({ message: `正在生成课程视频${progress}`, updated_at: new Date().toISOString() })
      .eq('id', jobId)
      .select('*')
      .single();
    if (error) throw error;
    return data as CourseVideoExportJob;
  }

  if (render.status === 'succeeded') {
    const response = await fetch(
      `${renderServiceUrl()}/render/${encodeURIComponent(job.render_job_id)}/download`,
    );
    if (!response.ok) throw new Error(`下载生成视频失败（HTTP ${response.status}）`);
    const video = await response.arrayBuffer();
    const { error: uploadError } = await service.storage
      .from(COURSE_ASSET_BUCKET)
      .upload(job.output_path!, video, { contentType: 'video/mp4', upsert: true });
    if (uploadError) throw new Error(`保存生成视频失败：${uploadError.message}`);
    const now = new Date().toISOString();
    const { data, error } = await service
      .from('course_video_export_jobs')
      .update({
        status: 'succeeded',
        message: '课程视频已生成',
        completed_at: now,
        updated_at: now,
      })
      .eq('id', jobId)
      .select('*')
      .single();
    if (error) throw error;
    return data as CourseVideoExportJob;
  }

  const terminalStatus = render.status === 'cancelled' ? 'cancelled' : 'failed';
  const now = new Date().toISOString();
  const { data, error } = await service
    .from('course_video_export_jobs')
    .update({
      status: terminalStatus,
      message: terminalStatus === 'cancelled' ? '已取消视频导出' : '课程视频生成失败',
      error: render.error ?? null,
      completed_at: now,
      updated_at: now,
    })
    .eq('id', jobId)
    .select('*')
    .single();
  if (error) throw error;
  return data as CourseVideoExportJob;
}

export async function createCourseVideoDownloadUrl(job: CourseVideoExportJob) {
  if (job.status !== 'succeeded' || !job.output_path) return null;
  const { data, error } = await getServiceSupabase().storage
    .from(COURSE_ASSET_BUCKET)
    .createSignedUrl(job.output_path, 60 * 60);
  if (error || !data) throw new Error(`创建视频下载地址失败：${error?.message ?? 'unknown'}`);
  return data.signedUrl;
}

export async function cancelCourseVideoExportJob(jobId: string) {
  const service = getServiceSupabase();
  const current = await getCourseVideoExportJob(jobId);
  if (current?.render_job_id && current.status === 'running') {
    await fetch(`${renderServiceUrl()}/render/${encodeURIComponent(current.render_job_id)}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  }
  const { data, error } = await service
    .from('course_video_export_jobs')
    .update({ status: 'cancelled', message: '已取消视频导出', completed_at: new Date().toISOString() })
    .eq('id', jobId)
    .in('status', ['uploading', 'queued', 'running'])
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data as CourseVideoExportJob | null;
}
