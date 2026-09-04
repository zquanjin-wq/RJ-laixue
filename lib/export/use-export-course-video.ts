'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useStageStore } from '@/lib/store/stage';
import { compileBrowserCourseVideo } from '@/lib/video-export/compile-browser-course-video';
import { planCourseVideoExport } from '@/lib/video-export/course-video-source';
import { useExportClassroom } from './use-export-classroom';

export function useExportCourseVideo() {
  const courseId = useStageStore((state) => state.stage?.id);
  const { exportClassroomZip } = useExportClassroom();
  const [preparing, setPreparing] = useState(false);

  const start = useCallback(async () => {
    if (!courseId || preparing) return;
    setPreparing(true);
    const toastId = toast.loading('正在准备课程视频…');
    try {
      const classroom = await exportClassroomZip({ download: false, notify: false });
      if (!classroom) throw new Error('当前课件没有可导出的内容。');
      const plan = planCourseVideoExport(classroom.manifest);
      if (plan.includedCount === 0) throw new Error('这门课程全部是互动内容，无法合成视频。');
      const bytes = await compileBrowserCourseVideo(classroom.manifest, classroom.audioByRef);
      const createdResponse = await fetch(`/api/courses/${encodeURIComponent(courseId)}/video-exports`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: 'mp4' }),
      });
      const created = await createdResponse.json() as { success?: boolean; error?: string; export?: { id?: string; inputUploadUrl?: string } };
      if (!createdResponse.ok || !created.success || !created.export?.id || !created.export.inputUploadUrl) throw new Error(created.error ?? '无法创建视频任务。');
      const upload = await fetch(created.export.inputUploadUrl, { method: 'PUT', headers: { 'content-type': 'application/zip' }, body: new Blob([new Uint8Array(bytes)], { type: 'application/zip' }) });
      if (!upload.ok) throw new Error(`视频素材上传失败（HTTP ${upload.status}）。`);
      const activatedResponse = await fetch(`/api/courses/${encodeURIComponent(courseId)}/video-exports`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: created.export.id }),
      });
      const activated = await activatedResponse.json() as { success?: boolean; error?: string };
      if (!activatedResponse.ok || !activated.success) throw new Error(activated.error ?? '无法启动视频任务。');
      toast.success('视频已转入后台生成，可在课程管理中查看进度和下载。', { id: toastId, duration: 7000 });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '视频导出失败。', { id: toastId });
    } finally { setPreparing(false); }
  }, [courseId, exportClassroomZip, preparing]);

  return { preparing, start };
}
