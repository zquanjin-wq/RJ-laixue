import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getCurrentActor, getCourse } = vi.hoisted(() => ({
  getCurrentActor: vi.fn(),
  getCourse: vi.fn(),
}));

vi.mock('@/lib/server/auth-context', () => ({ getCurrentActor }));
vi.mock('@/lib/server/db/pool', () => ({ getDatabasePool: vi.fn() }));
vi.mock('@/lib/server/db/course-repository', () => ({
  CourseRepository: class {
    getCourse = getCourse;
  },
}));

async function read(url: string) {
  const { GET } = await import('@/app/api/courses/[id]/route');
  return GET(new Request(url) as unknown as NextRequest, {
    params: Promise.resolve({ id: 'course-1' }),
  });
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('GET /api/courses/[id]', () => {
  it('allows a learner to open an internal share link', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'learner-1', role: 'learner' });
    getCourse.mockResolvedValue({
      id: 'course-1',
      ownerUserId: 'teacher-1',
      title: '课程',
      topic: null,
      content: { stage: {}, scenes: [] },
      saveState: 'ready',
      contentRevision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect((await read('http://localhost/api/courses/course-1?share=1')).status).toBe(200);
  });

  it('keeps normal learner reads for the learning-task slice', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'learner-1', role: 'learner' });
    getCourse.mockResolvedValue({ id: 'course-1' });

    expect((await read('http://localhost/api/courses/course-1')).status).toBe(403);
  });
});
