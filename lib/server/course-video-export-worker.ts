import {
  CourseVideoExportRepository,
  type CourseVideoExport,
} from '@/lib/server/db/course-video-export-repository';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { getDatabasePool } from '@/lib/server/db/pool';
import { CosStorage } from '@/lib/server/cos-storage';

type RenderState = {
  status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  error?: string;
  progress?: number;
  currentStage?: string;
  framesRendered?: number;
  totalFrames?: number;
};
type VideoRequest = {
  inputObjectKey?: string;
  sourceRevision?: number;
  render?: { jobId?: string };
};
const STALE_RUNNING_JOB_MS = 15 * 60 * 1000;
let courseVideoExportRunning = false;

function rendererUrl() {
  const url = process.env.RENDER_SERVICE_URL?.trim().replace(/\/$/, '');
  if (!url) throw new Error('RENDER_SERVICE_URL is not configured');
  return url;
}

function inputKey(job: CourseVideoExport) {
  const key = (job.request as VideoRequest | null)?.inputObjectKey;
  if (!key || !key.startsWith(`courses/${job.courseId}/video-exports/${job.id}/`)) {
    throw new Error('Video export input is missing or invalid');
  }
  return key;
}

function renderJobId(job: CourseVideoExport) {
  const id = (job.request as VideoRequest | null)?.render?.jobId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function sourceRevision(job: CourseVideoExport) {
  const revision = (job.request as VideoRequest | null)?.sourceRevision;
  return Number.isInteger(revision) ? revision! : null;
}

async function isCurrentCourseRevision(job: CourseVideoExport) {
  const revision = sourceRevision(job);
  if (revision === null) return false;
  const course = await new CourseRepository(getDatabasePool()).getCourse(job.courseId);
  return course?.contentRevision === revision;
}

async function responseJson<T>(response: Response, action: string): Promise<T> {
  if (!response.ok) throw new Error(`${action} failed (HTTP ${response.status})`);
  return response.json() as Promise<T>;
}

async function waitForRender(
  url: string,
  renderJobId: string,
  onProgress: (state: RenderState) => Promise<void>,
): Promise<RenderState> {
  for (;;) {
    const state = await responseJson<RenderState>(
      await fetch(`${url}/render/${encodeURIComponent(renderJobId)}`),
      'Read render status',
    );
    await onProgress(state);
    if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled')
      return state;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

export async function runNextCourseVideoExport(): Promise<boolean> {
  const repository = new CourseVideoExportRepository(getDatabasePool());
  await repository.failStaleRunning(STALE_RUNNING_JOB_MS);
  const job = (await repository.findRunningWithRender()) ?? (await repository.claimNext());
  if (!job) return false;
  try {
    if (!(await isCurrentCourseRevision(job))) {
      await repository.updateStatus({
        id: job.id,
        status: 'cancelled',
        expectedStatuses: ['running'],
        error: '课程内容已更新，本次视频任务已失效，请基于最新版本重新生成。',
      });
      return true;
    }
    const storage = new CosStorage();
    let activeRenderJobId = renderJobId(job);
    if (!activeRenderJobId) {
      const zip = await storage.getObject(inputKey(job));
      const form = new FormData();
      form.set(
        'project',
        new Blob([new Uint8Array(zip)], { type: 'application/zip' }),
        'course-video.zip',
      );
      form.set('format', 'mp4');
      form.set('quality', 'standard');
      const submitted = await responseJson<{ jobId?: string }>(
        await fetch(`${rendererUrl()}/render`, { method: 'POST', body: form }),
        'Submit video render',
      );
      if (!submitted.jobId) throw new Error('Render service did not return a job ID');
      activeRenderJobId = submitted.jobId;
      await repository.updateRenderProgress({
        id: job.id,
        renderJobId: activeRenderJobId,
        progress: 0,
        currentStage: 'queued',
      });
    }
    const completed = await waitForRender(rendererUrl(), activeRenderJobId, (state) =>
      repository
        .updateRenderProgress({
          id: job.id,
          renderJobId: activeRenderJobId,
          progress: state.progress ?? 0,
          currentStage: state.currentStage,
          framesRendered: state.framesRendered,
          totalFrames: state.totalFrames,
        })
        .then(() => undefined),
    );
    if (completed.status !== 'succeeded') {
      await repository.updateStatus({
        id: job.id,
        status: completed.status === 'cancelled' ? 'cancelled' : 'failed',
        expectedStatuses: ['running'],
        error: completed.error ?? 'Render failed',
      });
      return true;
    }
    const videoResponse = await fetch(
      `${rendererUrl()}/render/${encodeURIComponent(activeRenderJobId)}/download`,
    );
    if (!videoResponse.ok)
      throw new Error(`Download rendered video failed (HTTP ${videoResponse.status})`);
    const video = Buffer.from(await videoResponse.arrayBuffer());
    if (!(await isCurrentCourseRevision(job))) {
      await repository.updateStatus({
        id: job.id,
        status: 'cancelled',
        expectedStatuses: ['running'],
        error: '视频生成期间课程内容已更新，请基于最新版本重新生成。',
      });
      return true;
    }
    const objectKey = `courses/${job.courseId}/video-exports/${job.id}/course.mp4`;
    await storage.putObject(objectKey, video, 'video/mp4');
    await repository.recordOutput({
      id: job.id,
      output: {
        bucket: process.env.TENCENT_COS_BUCKET!,
        objectKey,
        contentType: 'video/mp4',
        sizeBytes: video.length,
      },
      expectedStatuses: ['running'],
    });
  } catch (error) {
    await repository.updateStatus({
      id: job.id,
      status: 'failed',
      expectedStatuses: ['running'],
      error: error instanceof Error ? error.message : 'Video export failed',
    });
  }
  return true;
}

export function startNextCourseVideoExport(): boolean {
  if (courseVideoExportRunning) return false;
  courseVideoExportRunning = true;
  void runNextCourseVideoExport()
    .catch((error) => console.error('[course-video-export-worker]', error))
    .finally(() => {
      courseVideoExportRunning = false;
    });
  return true;
}
