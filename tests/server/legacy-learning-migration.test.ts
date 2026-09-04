import { afterEach, describe, expect, it, vi } from 'vitest';

const { databaseQuery, getDatabasePool } = vi.hoisted(() => ({
  databaseQuery: vi.fn(),
  getDatabasePool: vi.fn(),
}));

vi.mock('@/lib/server/db/pool', () => ({ getDatabasePool }));

afterEach(() => {
  vi.resetAllMocks();
  getDatabasePool.mockReturnValue({ query: databaseQuery });
});

describe('legacy learner APIs', () => {
  it.each([
    [
      'access-code redemption',
      () =>
        import('@/app/api/access-code/redeem/route').then(({ POST }) =>
          POST(new Request('http://localhost/api/access-code/redeem', { method: 'POST' })),
        ),
    ],
    ['student management', () => import('@/app/api/students/route').then(({ GET }) => GET())],
    [
      'single-course assignments',
      () => import('@/app/api/courses/[id]/assignments/route').then(({ POST }) => POST()),
    ],
    [
      'access-code verification',
      () => import('@/app/api/learning/verify/route').then(({ POST }) => POST()),
    ],
  ])('returns 410 for %s', async (_name, request) => {
    const response = await request();

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'LEGACY_LEARNING_API_DEPRECATED',
    });
  });
});

describe('checkCourseReadAccess', () => {
  it('allows a learner only through a published task assignment', async () => {
    databaseQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM app.courses'))
        return { rows: [{ ownerUserId: 'teacher-1' }], rowCount: 1 };
      if (sql.includes('FROM app.user_profiles'))
        return { rows: [{ role: 'learner' }], rowCount: 1 };
      if (sql.includes('FROM app.task_courses')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { checkCourseReadAccess } = await import('@/lib/server/course-access');

    await expect(checkCourseReadAccess('learner-1', 'course-1')).resolves.toEqual({ ok: true });
    expect(databaseQuery).toHaveBeenLastCalledWith(
      expect.stringContaining("task.status = 'published'"),
      ['course-1', 'learner-1'],
    );
  });

  it('rejects a learner without a matching task assignment', async () => {
    databaseQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM app.courses'))
        return { rows: [{ ownerUserId: 'teacher-1' }], rowCount: 1 };
      if (sql.includes('FROM app.user_profiles'))
        return { rows: [{ role: 'learner' }], rowCount: 1 };
      if (sql.includes('FROM app.task_courses')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { checkCourseReadAccess } = await import('@/lib/server/course-access');

    await expect(checkCourseReadAccess('learner-1', 'course-1')).resolves.toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });
});
