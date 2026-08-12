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

function auth(user: { id: string } | null) {
  return { auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) } };
}

function service(role: string, owner: string) {
  const rows: Record<string, unknown[]> = {
    profiles: [{ role }],
    learning_tasks: [{ id: 'task-1', created_by: owner, due_at: null, snapshot_id: 'snap-1' }],
    task_learners: [
      {
        student_id: 's1',
        status: 'completed',
        progress_percent: 100,
        mastery_percent: 100,
        effective_seconds: 30,
        last_seen_at: '2026-08-01T00:00:00.000Z',
      },
      {
        student_id: 's2',
        status: 'not_started',
        progress_percent: 0,
        mastery_percent: null,
        effective_seconds: 0,
        last_seen_at: null,
      },
    ],
    task_learning_events: [
      { student_id: 's1', event_type: 'scene_completed', scene_id: 'slide-1' },
      { student_id: 's1', event_type: 'question_asked', scene_id: 'slide-1' },
    ],
    students: [
      { id: 's1', name: '张三' },
      { id: 's2', name: '李四' },
    ],
    course_snapshots: [
      { snapshot_data: { scenes: [{ id: 'slide-1', type: 'slide', title: '第一节', order: 1 }] } },
    ],
  };
  return {
    from(table: string) {
      const data = rows[table] ?? [];
      const chain: any = Promise.resolve({ data, error: null });
      chain.eq = () => chain;
      chain.in = () => chain;
      chain.maybeSingle = async () => ({ data: data[0] ?? null, error: null });
      return { select: () => chain };
    },
  };
}

afterEach(() => vi.resetAllMocks());

describe('GET /api/admin/learning-tasks/[id]/report', () => {
  it('未登录返回 401', async () => {
    getServerSupabaseMock.mockResolvedValue(auth(null));
    const { GET } = await import('@/app/api/admin/learning-tasks/[id]/report/route');
    const res = await GET(new Request('http://localhost') as NextRequest, {
      params: Promise.resolve({ id: 'task-1' }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).errorCode).toBe('UNAUTHENTICATED');
  });

  it('教师不能查看他人的任务', async () => {
    getServerSupabaseMock.mockResolvedValue(auth({ id: 'teacher-1' }));
    getServiceSupabaseMock.mockReturnValue(service('teacher', 'teacher-2'));
    const { GET } = await import('@/app/api/admin/learning-tasks/[id]/report/route');
    const res = await GET(new Request('http://localhost') as NextRequest, {
      params: Promise.resolve({ id: 'task-1' }),
    });
    expect(res.status).toBe(403);
  });

  it('任务所有者获得真实聚合数据', async () => {
    getServerSupabaseMock.mockResolvedValue(auth({ id: 'teacher-1' }));
    getServiceSupabaseMock.mockReturnValue(service('teacher', 'teacher-1'));
    const { GET } = await import('@/app/api/admin/learning-tasks/[id]/report/route');
    const res = await GET(new Request('http://localhost') as NextRequest, {
      params: Promise.resolve({ id: 'task-1' }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.overview).toMatchObject({ total: 2, completed: 1, effectiveSeconds: 30 });
    expect(json.data.chapters[0]).toMatchObject({ completedLearners: 1, questionsAsked: 1 });
    expect(json.data.learners[0].name).toBe('张三');
  });
});
