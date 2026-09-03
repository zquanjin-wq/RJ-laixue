import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getCurrentActor, getCourse, listForCourse } = vi.hoisted(() => ({
  getCurrentActor: vi.fn(),
  getCourse: vi.fn(),
  listForCourse: vi.fn(),
}));

vi.mock('@/lib/server/auth-context', () => ({ getCurrentActor }));
vi.mock('@/lib/server/db/pool', () => ({ getDatabasePool: vi.fn() }));
vi.mock('@/lib/server/db/course-repository', () => ({
  CourseRepository: class {
    getCourse = getCourse;
  },
}));
vi.mock('@/lib/export/video-export-service', () => ({
  getVideoExportService: () => ({
    getCapability: () => ({
      available: false,
      code: 'VIDEO_RENDERER_NOT_CONFIGURED',
      message: '视频渲染服务尚未配置',
    }),
    listForCourse,
  }),
  VideoRendererNotConfiguredError: class VideoRendererNotConfiguredError extends Error {},
}));

async function listVideoExports() {
  const { GET } = await import('@/app/api/courses/[id]/video-exports/route');
  return GET(new Request('http://localhost/api/courses/course-1/video-exports') as unknown as NextRequest, {
    params: Promise.resolve({ id: 'course-1' }),
  });
}

async function requestVideoExport() {
  const { POST } = await import('@/app/api/courses/[id]/video-exports/route');
  return POST(
    new Request('http://localhost/api/courses/course-1/video-exports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id: 'course-1' }) },
  );
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('GET /api/courses/[id]/video-exports', () => {
  it('does not expose another teacher’s course video jobs', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'teacher-2', role: 'teacher' });
    getCourse.mockResolvedValue({ id: 'course-1', ownerUserId: 'teacher-1' });

    expect((await listVideoExports()).status).toBe(404);
    expect(listForCourse).not.toHaveBeenCalled();
  });

  it('does not let a teacher request rendering for another teacher’s course', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'teacher-2', role: 'teacher' });
    getCourse.mockResolvedValue({ id: 'course-1', ownerUserId: 'teacher-1' });

    expect((await requestVideoExport()).status).toBe(404);
  });

  it('lets an administrator inspect every course video job', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
    getCourse.mockResolvedValue({ id: 'course-1', ownerUserId: 'teacher-1' });
    listForCourse.mockResolvedValue([]);

    const response = await listVideoExports();

    expect(response.status).toBe(200);
    expect(listForCourse).toHaveBeenCalledWith('course-1');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      capability: { available: false, code: 'VIDEO_RENDERER_NOT_CONFIGURED' },
    });
  });
});
