'use client';

import { useCallback, useEffect, useState } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase/client';
import { COURSE_ASSET_BUCKET } from '@/lib/course-assets/shared';
import { useStageStore } from '@/lib/store/stage';
import { compileBrowserCourseVideo } from '@/lib/video-export/compile-browser-course-video';
import { useExportClassroom } from './use-export-classroom';

interface VideoExportJobView {
  id: string;
  status: 'uploading' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  message: string;
  error?: string;
  progressCurrent?: number;
  progressTotal?: number;
  done: boolean;
  downloadUrl?: string;
}

interface SignedUpload {
  path: string;
  token: string;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json()) as { success?: boolean; error?: string } & T;
  if (!response.ok || body.success === false) {
    throw new Error(body.error || `请求失败（HTTP ${response.status}）`);
  }
  return body;
}

function storageKey(courseId: string) {
  return `course-video-export:${courseId}`;
}

export function useExportCourseVideo() {
  const courseId = useStageStore((state) => state.stage?.id);
  const { exportClassroomZip } = useExportClassroom();
  const [job, setJob] = useState<VideoExportJobView | null>(null);
  const [preparing, setPreparing] = useState(false);

  const refresh = useCallback(
    async (id: string) => {
      if (!courseId) return;
      const result = await requestJson<{ job: VideoExportJobView }>(
        `/api/courses/${encodeURIComponent(courseId)}/video-exports?jobId=${encodeURIComponent(id)}`,
      );
      setJob(result.job);
      if (result.job.done && result.job.status !== 'succeeded') {
        toast.error(result.job.error || result.job.message);
      }
    },
    [courseId],
  );

  useEffect(() => {
    if (!courseId) return;
    const savedJobId = localStorage.getItem(storageKey(courseId));
    if (savedJobId)
      void refresh(savedJobId).catch(() => {
        localStorage.removeItem(storageKey(courseId));
      });
  }, [courseId, refresh]);

  useEffect(() => {
    if (!job || job.done) return;
    const timer = window.setInterval(() => {
      void refresh(job.id).catch((error) => {
        console.error('[video-export] poll failed', error);
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [job, refresh]);

  const start = useCallback(async () => {
    if (!courseId || preparing || (job && !job.done)) return;
    setPreparing(true);
    const toastId = toast.loading('正在准备课程视频');
    try {
      const classroom = await exportClassroomZip({ download: false, notify: false });
      if (!classroom) throw new Error('当前课件没有可导出的内容');
      const bytes = await compileBrowserCourseVideo(classroom.manifest, classroom.audioByRef);
      const source = new Blob([Uint8Array.from(bytes)], { type: 'application/zip' });

      const created = await requestJson<{
        job: VideoExportJobView;
        upload: SignedUpload;
      }>(`/api/courses/${encodeURIComponent(courseId)}/video-exports`, { method: 'POST' });
      const { error: uploadError } = await supabase.storage
        .from(COURSE_ASSET_BUCKET)
        .uploadToSignedUrl(created.upload.path, created.upload.token, source, {
          contentType: 'application/zip',
          upsert: true,
        });
      if (uploadError) throw new Error(`上传视频素材失败：${uploadError.message}`);

      const started = await requestJson<{ job: VideoExportJobView }>(
        `/api/courses/${encodeURIComponent(courseId)}/video-exports`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobId: created.job.id }),
        },
      );
      localStorage.setItem(storageKey(courseId), started.job.id);
      setJob(started.job);
      toast.success('视频已转入后台生成，现在可以离开。可在“课程管理 → 视频导出”查看。', {
        id: toastId,
        duration: 8000,
        action: {
          label: '查看任务',
          onClick: () => window.open('/courses#video-exports', '_blank'),
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '视频导出失败', { id: toastId });
    } finally {
      setPreparing(false);
    }
  }, [courseId, exportClassroomZip, job, preparing]);

  const download = useCallback(async () => {
    if (!job?.downloadUrl) return;
    try {
      // A direct navigation lets the browser play an MP4 inline. Fetching the
      // signed file first keeps the user in the classroom and triggers a real
      // file download instead.
      const response = await fetch(job.downloadUrl);
      if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
      saveAs(await response.blob(), 'course.mp4');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '视频下载失败，请重试');
    }
  }, [job]);

  return {
    job,
    preparing,
    active: preparing || Boolean(job && !job.done),
    start,
    download,
  };
}
