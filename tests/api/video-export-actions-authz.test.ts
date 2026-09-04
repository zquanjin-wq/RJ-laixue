import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getCurrentActor, getCourse, getExport, retry, updateStatus, getById } = vi.hoisted(() => ({
  getCurrentActor: vi.fn(), getCourse: vi.fn(), getExport: vi.fn(), retry: vi.fn(), updateStatus: vi.fn(), getById: vi.fn(),
}));

vi.mock('@/lib/server/auth-context', () => ({ getCurrentActor }));
vi.mock('@/lib/server/db/pool', () => ({ getDatabasePool: vi.fn() }));
vi.mock('@/lib/server/db/course-repository', () => ({ CourseRepository: class { getCourse = getCourse; } }));
vi.mock('@/lib/server/db/course-video-export-repository', () => ({ CourseVideoExportRepository: class { get = getExport; retry = retry; updateStatus = updateStatus; } }));
vi.mock('@/lib/export/video-export-service', () => ({
  getVideoExportService: () => ({ getById, getCapability: vi.fn() }),
}));

async function changeJob(action: 'cancel' | 'retry') {
  const { POST } = await import('@/app/api/video-exports/[id]/route');
  return POST(new Request('http://localhost/api/video-exports/job-1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) }) as unknown as NextRequest, { params: Promise.resolve({ id: 'job-1' }) });
}

afterEach(() => vi.resetAllMocks());

describe('POST /api/video-exports/[id]', () => {
  it('does not let a teacher cancel another teacher’s video export', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'teacher-2', role: 'teacher' });
    getExport.mockResolvedValue({ id: 'job-1', courseId: 'course-1', status: 'queued' });
    getCourse.mockResolvedValue({ id: 'course-1', ownerUserId: 'teacher-1' });

    expect((await changeJob('cancel')).status).toBe(404);
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('does not let a teacher retry another teacher’s video export', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'teacher-2', role: 'teacher' });
    getExport.mockResolvedValue({ id: 'job-1', courseId: 'course-1', status: 'failed' });
    getCourse.mockResolvedValue({ id: 'course-1', ownerUserId: 'teacher-1' });

    expect((await changeJob('retry')).status).toBe(404);
    expect(retry).not.toHaveBeenCalled();
  });
});
