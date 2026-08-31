import { apiError, apiSuccess } from '@/lib/server/api-response';
import { requireAuthOrTeacher } from '@/lib/server/api-guard';
import {
  createCourseVideoDownloadUrl,
  listCourseVideoExportJobs,
  presentCourseVideoExportJob,
} from '@/lib/server/course-video-export-jobs';

export const runtime = 'nodejs';

export async function GET() {
  const auth = await requireAuthOrTeacher(['teacher', 'admin']);
  if (!auth.ok) return auth.response;
  try {
    const jobs = await listCourseVideoExportJobs(auth.user.id);
    const presented = await Promise.all(
      jobs.map(async (job) => {
        const downloadUrl = await createCourseVideoDownloadUrl(job);
        return presentCourseVideoExportJob(job, downloadUrl);
      }),
    );
    return apiSuccess({ jobs: presented });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : '读取视频导出任务失败',
    );
  }
}
