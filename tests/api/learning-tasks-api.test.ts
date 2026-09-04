import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { requireUser, canManageCourse, query, createTask } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  canManageCourse: vi.fn(),
  query: vi.fn(),
  createTask: vi.fn(),
}));

vi.mock('@/lib/server/auth-context', () => ({ requireUser }));
vi.mock('@/lib/server/db/pool', () => ({ getDatabasePool: () => ({ query }) }));
vi.mock('@/lib/server/db/access-repository', () => ({
  AccessRepository: class { canManageCourse = canManageCourse; },
}));
vi.mock('@/lib/server/db/task-repository', () => ({
  TaskRepository: class { createTask = createTask; },
}));

async function post(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/admin/learning-tasks/route');
  return POST(new Request('http://localhost/api/admin/learning-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as NextRequest);
}

const validRequest = {
  title: '安全培训',
  courseIds: ['course-1'],
  learnerIds: ['learner-1'],
};

afterEach(() => vi.resetAllMocks());

describe('POST /api/admin/learning-tasks', () => {
  it('rejects unauthenticated requests', async () => {
    requireUser.mockRejectedValue(new Error('Unauthenticated'));

    expect((await post(validRequest)).status).toBe(401);
  });

  it('rejects learner accounts', async () => {
    requireUser.mockResolvedValue({ userId: 'learner-1', role: 'learner' });

    expect((await post(validRequest)).status).toBe(403);
  });

  it('requires a title, course, and learner', async () => {
    requireUser.mockResolvedValue({ userId: 'teacher-1', role: 'teacher' });

    expect((await post({ title: '', courseIds: [], learnerIds: [] })).status).toBe(400);
  });

  it('requires a teacher to own every selected course', async () => {
    requireUser.mockResolvedValue({ userId: 'teacher-1', role: 'teacher' });
    canManageCourse.mockResolvedValue(false);

    const response = await post(validRequest);

    expect(response.status).toBe(403);
    expect(createTask).not.toHaveBeenCalled();
  });

  it('rejects disabled or unknown learners', async () => {
    requireUser.mockResolvedValue({ userId: 'teacher-1', role: 'teacher' });
    canManageCourse.mockResolvedValue(true);
    query.mockResolvedValue({ rowCount: 0, rows: [] });

    expect((await post(validRequest)).status).toBe(400);
    expect(createTask).not.toHaveBeenCalled();
  });

  it('creates a task with the authenticated teacher as owner', async () => {
    requireUser.mockResolvedValue({ userId: 'teacher-1', role: 'teacher' });
    canManageCourse.mockResolvedValue(true);
    query.mockResolvedValue({ rowCount: 1, rows: [{ id: 'learner-1' }] });
    createTask.mockResolvedValue('task-1');

    const response = await post(validRequest);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ success: true, data: { id: 'task-1' } });
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: 'teacher-1',
      courses: [{ courseId: 'course-1' }],
      userIds: ['learner-1'],
    }));
  });
});
