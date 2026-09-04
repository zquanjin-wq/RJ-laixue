import { afterEach, describe, expect, it, vi } from 'vitest';

const { getCurrentActorMock, queryMock } = vi.hoisted(() => ({
  getCurrentActorMock: vi.fn(),
  queryMock: vi.fn(),
}));
vi.mock('@/lib/server/auth-context', () => ({ getCurrentActor: getCurrentActorMock }));
vi.mock('@/lib/server/db/pool', () => ({ getDatabasePool: () => ({ query: queryMock }) }));

afterEach(() => vi.resetAllMocks());

describe('GET /api/admin/course-analytics', () => {
  it('rejects learner-only accounts', async () => {
    getCurrentActorMock.mockResolvedValue({ userId: 'learner-1', role: 'learner' });
    const { GET } = await import('@/app/api/admin/course-analytics/route');
    expect((await GET()).status).toBe(403);
  });

  it('returns course-level aggregate data for a teacher', async () => {
    getCurrentActorMock.mockResolvedValue({ userId: 'teacher-1', role: 'teacher' });
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'course-1', title: '课程一', updatedAt: null }] })
      .mockResolvedValueOnce({ rows: [{ courseId: 'course-1', taskId: 'task-1', userId: 'learner-1', status: 'completed', effectiveSeconds: 120 }] });
    const { GET } = await import('@/app/api/admin/course-analytics/route');
    const response = await GET();
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data.courses[0]).toMatchObject({ courseId: 'course-1', learnerCount: 1, completedCount: 1, completionRate: 100, effectiveSeconds: 120 });
  });
});
