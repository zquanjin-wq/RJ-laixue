import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getCurrentActor, getCourse, listForCourse, requestExport } = vi.hoisted(() => ({
  getCurrentActor: vi.fn(),
  getCourse: vi.fn(),
  listForCourse: vi.fn(),
  requestExport: vi.fn(),
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
    request: requestExport,
  }),
  VideoRendererNotConfiguredError: class VideoRendererNotConfiguredError extends Error {},
}));

async function listVideoExports() {
  const { GET } = await import('@/app/api/courses/[id]/video-exports/route');
  return GET(
    new Request('http://localhost/api/courses/course-1/video-exports') as unknown as NextRequest,
    {
      params: Promise.resolve({ id: 'course-1' }),
    },
  );
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

  it('only exposes video jobs generated from the current course revision', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'teacher-1', role: 'teacher' });
    getCourse.mockResolvedValue({ id: 'course-1', ownerUserId: 'teacher-1', contentRevision: 7 });
    listForCourse.mockResolvedValue([
      { id: 'current', sourceRevision: 7 },
      { id: 'stale', sourceRevision: 6 },
      { id: 'legacy', sourceRevision: null },
    ]);

    const response = await listVideoExports();

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      currentRevision: 7,
      exports: [{ id: 'current', sourceRevision: 7 }],
    });
  });

  it('anchors a new video job to the persisted course revision', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'teacher-1', role: 'teacher' });
    getCourse.mockResolvedValue({ id: 'course-1', ownerUserId: 'teacher-1', contentRevision: 8 });
    requestExport.mockResolvedValue({ id: 'video-1' });

    const response = await requestVideoExport();

    expect(response.status).toBe(202);
    expect(requestExport).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: 'course-1',
        requestedBy: 'teacher-1',
        sourceRevision: 8,
      }),
    );
  });
});
