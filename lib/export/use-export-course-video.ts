'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useStageStore } from '@/lib/store/stage';
import { useCourseCloudSaveStore } from '@/lib/store/course-cloud-save';
import { compileBrowserCourseVideo } from '@/lib/video-export/compile-browser-course-video';
import { planCourseVideoExport } from '@/lib/video-export/course-video-source';
import { useExportClassroom } from './use-export-classroom';
import type { VideoExportPreset } from './video-export-contract';

type VideoExportStatus = 'queued' | 'rendering' | 'completed' | 'failed' | 'cancelled';
type VideoExport = {
  status: VideoExportStatus;
  failureReason?: string | null;
  progress?: number | null;
};

async function readJsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  if (!text.trim()) throw new Error(`${fallback}（服务器返回了空响应，HTTP ${response.status}）。`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${fallback}（服务器响应格式异常，HTTP ${response.status}）。`);
  }
}

async function watchVideoExport(courseId: string, jobId: string, toastId: string | number) {
  for (;;) {
    await new Promise((resolve) => window.setTimeout(resolve, 5_000));
    const response = await fetch(`/api/video-exports/${encodeURIComponent(jobId)}`, {
      cache: 'no-store',
    });
    const payload = await readJsonResponse<{
      success?: boolean;
      export?: VideoExport;
    }>(response, '读取视频任务失败').catch(() => null);
    const job = payload?.export;
    if (!response.ok || !payload?.success || !job) return;
    if (job.status === 'completed') {
      toast.success('课程视频已生成，可在课程管理中下载。', { id: toastId, duration: 8_000 });
      return;
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      toast.error(
        job.failureReason ?? (job.status === 'cancelled' ? '视频生成已取消。' : '视频生成失败。'),
        { id: toastId, duration: 10_000 },
      );
      return;
    }
    const progress = typeof job.progress === 'number' ? ` ${Math.round(job.progress * 100)}%` : '';
    toast.loading(`课程视频生成中${progress}`, { id: toastId });
  }
}

export function useExportCourseVideo() {
  const courseId = useStageStore((state) => state.stage?.id);
  const { exportClassroomZip } = useExportClassroom();
  const [preparing, setPreparing] = useState(false);
  const cloudSaveStatus = useCourseCloudSaveStore((state) => state.status);

  const start = useCallback(
    async (preset: VideoExportPreset = 'standard') => {
      if (!courseId || preparing) return;
      setPreparing(true);
      const toastId = toast.loading('正在准备课程视频…');
      try {
        if (cloudSaveStatus === 'dirty' || cloudSaveStatus === 'saving') {
          throw new Error('课程还有未保存的修改，请先保存到云端后再生成视频。');
        }
        if (cloudSaveStatus === 'failed') {
          throw new Error('课程最近一次保存失败，请重新保存到云端后再生成视频。');
        }
        // Video tasks render from a durable cloud snapshot. Do not quietly save
        // a local draft here: saving can publish narration and is an authoring
        // decision the user must make explicitly through the primary Save action.
        const courseResponse = await fetch(`/api/courses/${encodeURIComponent(courseId)}`, {
          cache: 'no-store',
        });
        const coursePayload = (await courseResponse.json().catch(() => null)) as {
          success?: boolean;
          data?: { save_state?: string; content_revision?: number };
        } | null;
        if (
          !courseResponse.ok ||
          !coursePayload?.success ||
          coursePayload.data?.save_state !== 'ready'
        ) {
          throw new Error('课程还未保存到云端，请先点击“保存到云端”后再生成视频。');
        }
        const classroom = await exportClassroomZip({ download: false, notify: false });
        if (!classroom) throw new Error('当前课件没有可导出的内容。');
        const plan = planCourseVideoExport(classroom.manifest);
        if (plan.includedCount === 0) throw new Error('这门课程全部是互动内容，无法合成视频。');
        const bytes = await compileBrowserCourseVideo(classroom.manifest, classroom.audioByRef);
        const createdResponse = await fetch(
          `/api/courses/${encodeURIComponent(courseId)}/video-exports`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              format: 'mp4',
              preset,
              sourceRevision: coursePayload.data.content_revision,
            }),
          },
        );
        const created = await readJsonResponse<{
          success?: boolean;
          error?: string;
          export?: { id?: string; inputUploadUrl?: string };
        }>(createdResponse, '创建视频任务失败');
        if (
          !createdResponse.ok ||
          !created.success ||
          !created.export?.id ||
          !created.export.inputUploadUrl
        )
          throw new Error(created.error ?? '无法创建视频任务。');
        const upload = await fetch(created.export.inputUploadUrl, {
          method: 'PUT',
          headers: { 'content-type': 'application/zip' },
          body: new Blob([new Uint8Array(bytes)], { type: 'application/zip' }),
        });
        if (!upload.ok) throw new Error(`视频素材上传失败（HTTP ${upload.status}）。`);
        const activatedResponse = await fetch(
          `/api/courses/${encodeURIComponent(courseId)}/video-exports`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId: created.export.id }),
          },
        );
        const activated = await readJsonResponse<{ success?: boolean; error?: string }>(
          activatedResponse,
          '启动视频任务失败',
        );
        if (!activatedResponse.ok || !activated.success)
          throw new Error(activated.error ?? '无法启动视频任务。');
        toast.loading(
          preset === 'fast'
            ? '快速视频已提交（720p · 20fps），正在等待渲染。'
            : '标准视频已提交（720p · 24fps），正在等待渲染。',
          { id: toastId },
        );
        void watchVideoExport(courseId, created.export.id, toastId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '视频导出失败。', { id: toastId });
      } finally {
        setPreparing(false);
      }
    },
    [cloudSaveStatus, courseId, exportClassroomZip, preparing],
  );

  return { preparing, start };
}
