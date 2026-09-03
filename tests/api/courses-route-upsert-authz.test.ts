import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, type NextRequest as NextRequestType } from 'next/server';

const {
  getCurrentActor,
  getCourse,
  createCourse,
  updateCourse,
  listOwnedCourses,
  listCourses,
} = vi.hoisted(() => ({
  getCurrentActor: vi.fn(),
  getCourse: vi.fn(),
  createCourse: vi.fn(),
  updateCourse: vi.fn(),
  listOwnedCourses: vi.fn(),
  listCourses: vi.fn(),
}));

vi.mock('@/lib/server/auth-context', () => ({ getCurrentActor }));
vi.mock('@/lib/server/db/pool', () => ({ getDatabasePool: vi.fn() }));
vi.mock('@/lib/server/db/course-repository', () => ({
  CourseRepository: class {
    getCourse = getCourse;
    createCourse = createCourse;
    updateCourse = updateCourse;
    listOwnedCourses = listOwnedCourses;
    listCourses = listCourses;
  },
}));

async function post(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/courses/route');
  return POST(
    new Request('http://localhost/api/courses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequestType,
  );
}

async function list(scope = 'mine') {
  const { GET } = await import('@/app/api/courses/route');
  return GET(new NextRequest(`http://localhost/api/courses?scope=${scope}`));
}

const draft = { id: 'course-1', data: { stage: { name: '课程' } } };
const course = {
  id: 'course-1',
  title: '课程',
  topic: '主题',
  content: {},
  saveState: 'ready',
  contentRevision: 2,
  ownerUserId: 'teacher-1',
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-02T00:00:00.000Z'),
};

afterEach(() => {
  vi.resetAllMocks();
});

describe('GET /api/courses', () => {
  it('lists only the teacher owned courses and exposes the persisted save state', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'teacher-1', role: 'teacher' });
    listOwnedCourses.mockResolvedValue([course]);

    const response = await list();

    expect(response.status).toBe(200);
    expect(listOwnedCourses).toHaveBeenCalledWith('teacher-1');
    expect(listCourses).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [expect.objectContaining({ id: 'course-1', save_state: 'ready', created_by: 'teacher-1' })],
    });
  });

  it('lets administrators view every course', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
    listCourses.mockResolvedValue([course]);

    expect((await list('all')).status).toBe(200);
    expect(listCourses).toHaveBeenCalledOnce();
  });
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
