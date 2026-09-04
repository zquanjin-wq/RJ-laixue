import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getCurrentActor, canManageTask, getTask, getTaskAnalytics } = vi.hoisted(() => ({
  getCurrentActor: vi.fn(),
  canManageTask: vi.fn(),
  getTask: vi.fn(),
  getTaskAnalytics: vi.fn(),
}));

vi.mock('@/lib/server/auth-context', () => ({ getCurrentActor }));
vi.mock('@/lib/server/db/pool', () => ({ getDatabasePool: vi.fn(() => ({})) }));
vi.mock('@/lib/server/db/access-repository', () => ({
  AccessRepository: class { canManageTask = canManageTask; },
}));
vi.mock('@/lib/server/db/learning-analytics-repository', () => ({
  LearningAnalyticsRepository: class {
    getTask = getTask;
    getTaskAnalytics = getTaskAnalytics;
  },
}));

async function getReport() {
  const { GET } = await import('@/app/api/admin/learning-tasks/[id]/report/route');
  return GET(new Request('http://localhost') as NextRequest, { params: Promise.resolve({ id: 'task-1' }) });
}

afterEach(() => vi.resetAllMocks());

describe('GET /api/admin/learning-tasks/[id]/report', () => {
  it('rejects unauthenticated requests', async () => {
    getCurrentActor.mockResolvedValue(null);

    const response = await getReport();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'UNAUTHENTICATED' });
  });

  it('rejects teachers who cannot manage the task', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'teacher-1', role: 'teacher' });
    canManageTask.mockResolvedValue(false);

    expect((await getReport()).status).toBe(403);
    expect(getTask).not.toHaveBeenCalled();
  });

  it('returns PostgreSQL aggregate data to the task manager', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'teacher-1', role: 'teacher' });
    canManageTask.mockResolvedValue(true);
    getTask.mockResolvedValue({ id: 'task-1', due_at: null });
    getTaskAnalytics.mockResolvedValue({
      learners: [
        { student_id: 'learner-1', name: '张三', status: 'completed', progress_percent: 100, mastery_percent: 100, effective_seconds: 30, last_seen_at: '2026-09-01T00:00:00.000Z' },
        { student_id: 'learner-2', name: '李四', status: 'not_started', progress_percent: 0, mastery_percent: null, effective_seconds: 0, last_seen_at: null },
      ],
      courses: [{ course_id: 'course-1', title: '课程一', position: 1, is_required: true }],
      progress: [
        { course_id: 'course-1', status: 'completed', effective_seconds: 30 },
        { course_id: 'course-1', status: 'not_started', effective_seconds: 0 },
      ],
    });

    const response = await getReport();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.overview).toMatchObject({ total: 2, completed: 1, effectiveSeconds: 30 });
    expect(body.data.courses).toEqual([expect.objectContaining({ courseId: 'course-1', completionRate: 50 })]);
    expect(body.data.learners[0]).toMatchObject({ name: '张三', displayStatus: 'completed' });
  });
});
