import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getCurrentActor, getCourse, createCourse, updateCourse } = vi.hoisted(() => ({
  getCurrentActor: vi.fn(),
  getCourse: vi.fn(),
  createCourse: vi.fn(),
  updateCourse: vi.fn(),
}));

vi.mock('@/lib/server/auth-context', () => ({ getCurrentActor }));
vi.mock('@/lib/server/db/pool', () => ({ getDatabasePool: vi.fn() }));
vi.mock('@/lib/server/db/course-repository', () => ({
  CourseRepository: class {
    getCourse = getCourse;
    createCourse = createCourse;
    updateCourse = updateCourse;
  },
}));

async function post(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/courses/route');
  return POST(
    new Request('http://localhost/api/courses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
  );
}

const draft = { id: 'course-1', data: { stage: { name: '课程' } } };

afterEach(() => {
  vi.resetAllMocks();
});

describe('POST /api/courses', () => {
  it('rejects unauthenticated saves', async () => {
    getCurrentActor.mockResolvedValue(null);
    expect((await post(draft)).status).toBe(401);
  });

  it('creates a course for its teacher', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'teacher-1', role: 'teacher' });
    getCourse.mockResolvedValue(null);
    createCourse.mockResolvedValue({ id: 'course-1' });

    expect((await post(draft)).status).toBe(200);
    expect(createCourse).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'course-1', ownerUserId: 'teacher-1' }),
    );
  });

  it('does not let one teacher overwrite another teacher’s course', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'teacher-2', role: 'teacher' });
    getCourse.mockResolvedValue({ id: 'course-1', ownerUserId: 'teacher-1' });

    expect((await post(draft)).status).toBe(403);
    expect(updateCourse).not.toHaveBeenCalled();
  });

  it('allows an administrator to update an existing course without changing its owner', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
    getCourse.mockResolvedValue({
      id: 'course-1',
      ownerUserId: 'teacher-1',
      contentRevision: 3,
    });
    updateCourse.mockResolvedValue({ id: 'course-1' });

    expect((await post(draft)).status).toBe(200);
    expect(updateCourse).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: 'teacher-1', expectedRevision: 3 }),
    );
  });
});
