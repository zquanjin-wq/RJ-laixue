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
  const { error } = await service.from('course_video_export_jobs').insert(job);
  if (error) throw new Error(`创建视频导出任务失败：${error.message}`);
  const { data, error: uploadError } = await service.storage
    .from(COURSE_ASSET_BUCKET)
    .createSignedUploadUrl(inputPath, { upsert: true });
  if (uploadError || !data) throw new Error(`创建视频导出上传地址失败：${uploadError?.message ?? 'unknown'}`);
  return { job, upload: data };
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

export async function cancelCourseVideoExportJob(jobId: string) {
  const { data, error } = await getServiceSupabase()
    .from('course_video_export_jobs')
    .update({ status: 'cancelled', message: '已取消视频导出', completed_at: new Date().toISOString() })
    .eq('id', jobId)
    .in('status', ['uploading', 'queued', 'running'])
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data as CourseVideoExportJob | null;
}
