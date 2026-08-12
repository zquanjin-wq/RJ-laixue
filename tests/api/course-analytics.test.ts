import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getServerSupabaseMock, getServiceSupabaseMock } = vi.hoisted(() => ({
  getServerSupabaseMock: vi.fn(),
  getServiceSupabaseMock: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({
  getServerSupabase: getServerSupabaseMock,
  getServiceSupabase: getServiceSupabaseMock,
}));
function server(user: { id: string; email?: string } | null) {
  return { auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) } };
}
function service(role: string) {
  return {
    from(table: string) {
      const rows: Record<string, unknown[]> = {
        profiles: [{ role }],
        courses: [{ id: 'course-1', title: '课程一', created_by: 'teacher-1', updated_at: null }],
        task_course_progress: [
          {
            task_id: 'task-1',
            course_id: 'course-1',
            student_id: 'student-1',
            status: 'completed',
            effective_seconds: 120,
          },
        ],
      };
      const data = rows[table] ?? [];
      const chain: any = Promise.resolve({ data, error: null });
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.in = () => chain;
      chain.order = () => chain;
      chain.maybeSingle = async () => ({ data: data[0] ?? null, error: null });
      return chain;
    },
  };
}
afterEach(() => vi.resetAllMocks());
describe('GET /api/admin/course-analytics', () => {
  it('rejects learner-only accounts', async () => {
    getServerSupabaseMock.mockResolvedValue(server({ id: 'learner-1' }));
    getServiceSupabaseMock.mockReturnValue(service('learner'));
    const { GET } = await import('@/app/api/admin/course-analytics/route');
    expect((await GET()).status).toBe(403);
  });
  it('returns course-level aggregate data for a teacher', async () => {
    getServerSupabaseMock.mockResolvedValue(
      server({ id: 'teacher-1', email: 'teacher@example.com' }),
    );
    getServiceSupabaseMock.mockReturnValue(service('teacher'));
    const { GET } = await import('@/app/api/admin/course-analytics/route');
    const response = await GET();
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data.courses[0]).toMatchObject({
      courseId: 'course-1',
      learnerCount: 1,
      completedCount: 1,
      completionRate: 100,
      effectiveSeconds: 120,
    });
  });
});
