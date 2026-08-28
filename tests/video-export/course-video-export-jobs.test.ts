import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  job: null as Record<string, unknown> | null,
  uploads: [] as Array<{ path: string; body: unknown; options: unknown }>,
}));

const getServiceSupabase = vi.hoisted(() => vi.fn(() => ({
  from: () => ({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: state.job, error: null }) }),
    }),
    update: (patch: Record<string, unknown>) => ({
      eq: () => {
        const finish = async () => {
            state.job = { ...state.job, ...patch };
            return { data: state.job, error: null };
        };
        return {
          select: () => ({ single: finish }),
          in: () => ({ select: () => ({ maybeSingle: finish }) }),
        };
      },
    }),
  }),
  storage: {
    from: () => ({
      download: async () => ({ data: new Blob(['zip']), error: null }),
      upload: async (path: string, body: unknown, options: unknown) => {
        state.uploads.push({ path, body, options });
        return { error: null };
      },
      createSignedUrl: async () => ({ data: { signedUrl: 'https://download.test/course.mp4' }, error: null }),
    }),
  },
})));

vi.mock('@/lib/supabase/server', () => ({ getServiceSupabase }));

import {
  cancelCourseVideoExportJob,
  createCourseVideoDownloadUrl,
  startCourseVideoExportJob,
  syncCourseVideoExportJob,
} from '@/lib/server/course-video-export-jobs';

function job(status = 'uploading') {
  return {
    id: 'job-1',
    course_id: 'course-1',
    requested_by: 'user-1',
    status,
    input_path: 'courses/course-1/video-exports/job-1/source.zip',
    output_path: 'courses/course-1/video-exports/job-1/course.mp4',
    render_job_id: status === 'running' ? 'render-1' : null,
    message: '',
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:00:00.000Z',
  };
}

describe('course video export render bridge', () => {
  beforeEach(() => {
    process.env.VIDEO_RENDER_SERVICE_URL = 'https://render-preview.laixue.work/';
    state.job = job();
    state.uploads = [];
    vi.restoreAllMocks();
  });

  it('submits the uploaded ZIP and records the renderer job', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ jobId: 'render-1' }), { status: 200 }),
    );

    const result = await startCourseVideoExportJob('job-1');

    expect(result?.status).toBe('running');
    expect(result?.render_job_id).toBe('render-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://render-preview.laixue.work/render',
      expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
    );
  });

  it('downloads a completed render, stores the MP4 and exposes a signed URL', async () => {
    state.job = job('running');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'succeeded' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const result = await syncCourseVideoExportJob('job-1');
    const downloadUrl = await createCourseVideoDownloadUrl(result!);

    expect(result?.status).toBe('succeeded');
    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0]).toMatchObject({
      path: 'courses/course-1/video-exports/job-1/course.mp4',
      options: { contentType: 'video/mp4', upsert: true },
    });
    expect(downloadUrl).toBe('https://download.test/course.mp4');
  });

  it('cancels the renderer before closing the local job', async () => {
    state.job = job('running');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    const result = await cancelCourseVideoExportJob('job-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://render-preview.laixue.work/render/render-1',
      { method: 'DELETE' },
    );
    expect(result?.status).toBe('cancelled');
  });
});
