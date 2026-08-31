import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  jobs: [] as Array<Record<string, unknown>>,
}));

const getServiceSupabase = vi.hoisted(() =>
  vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: (_field: string, value: string) => ({
          maybeSingle: async () => ({
            data: state.jobs.find((job) => job.id === value) ?? null,
            error: null,
          }),
        }),
        in: (_field: string, statuses: string[]) => ({
          order: () => ({
            limit: async () => ({
              data: state.jobs.filter((job) => statuses.includes(String(job.status))),
              error: null,
            }),
          }),
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: (field: string, value: string) => ({
          lt: async () => ({ data: null, error: null }),
          select: () => ({
            single: async () => {
              const job = state.jobs.find((item) => item[field] === value);
              if (job) Object.assign(job, patch);
              return { data: job ?? null, error: null };
            },
          }),
        }),
      }),
    }),
  })),
);

vi.mock('@/lib/supabase/server', () => ({ getServiceSupabase }));

import { reconcileCourseVideoExportJobs } from '@/lib/server/course-video-export-jobs';

describe('course video export background worker', () => {
  beforeEach(() => {
    process.env.VIDEO_RENDER_SERVICE_URL = 'https://render-preview.laixue.work';
    state.jobs = [
      {
        id: 'job-1',
        course_id: 'course-1',
        requested_by: 'teacher-1',
        status: 'running',
        input_path: 'source.zip',
        output_path: 'course.mp4',
        render_job_id: 'render-1',
        message: '正在生成课程视频',
        created_at: '2026-08-31T00:00:00.000Z',
        updated_at: '2026-08-31T00:00:00.000Z',
      },
    ];
    vi.restoreAllMocks();
  });

  it('updates render progress without relying on an open classroom page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'running', frame: 48, totalFrames: 240 }), {
        status: 200,
      }),
    );

    const result = await reconcileCourseVideoExportJobs();

    expect(result).toEqual({ checked: 1, completed: 0, failed: 0 });
    expect(state.jobs[0]).toMatchObject({
      status: 'running',
      progress_current: 48,
      progress_total: 240,
    });
  });
});
