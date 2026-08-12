import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getServerSupabaseMock, getServiceSupabaseMock, callLLMMock } = vi.hoisted(() => ({
  getServerSupabaseMock: vi.fn(),
  getServiceSupabaseMock: vi.fn(),
  callLLMMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  getServerSupabase: getServerSupabaseMock,
  getServiceSupabase: getServiceSupabaseMock,
}));
vi.mock('@/lib/ai/llm', () => ({ callLLM: callLLMMock }));

function auth(user: { id: string } | null) {
  return { auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) } };
}

function chain(data: unknown) {
  const value: any = Promise.resolve({ data, error: null });
  value.eq = () => value;
  value.in = () => value;
  value.order = () => value;
  value.maybeSingle = async () => ({
    data: Array.isArray(data) ? (data[0] ?? null) : data,
    error: null,
  });
  value.select = () => value;
  value.update = () => value;
  value.insert = () => value;
  return value;
}

function service() {
  const rpc = vi.fn().mockResolvedValue({ data: { task_id: 'remedial-1' }, error: null });
  return {
    rpc,
    from(table: string) {
      const rows: Record<string, unknown> = {
        profiles: [{ role: 'teacher' }],
        ai_intervention_suggestions: [
          {
            id: 'suggestion-1',
            task_id: 'task-1',
            learner_ids: ['s1'],
            scene_ids: ['scene-1'],
            reason: '补学',
            status: 'pending',
            created_task_id: null,
          },
        ],
        learning_tasks: [
          { id: 'task-1', created_by: 'teacher-1', course_id: 'course-1', title: '原任务' },
        ],
      };
      return { select: () => chain(rows[table] ?? []), update: () => chain([]) };
    },
  };
}

afterEach(() => vi.resetAllMocks());

describe('learning task AI brief routes', () => {
  it('requires a signed-in teacher before generating a brief', async () => {
    getServerSupabaseMock.mockResolvedValue(auth(null));
    const { POST } = await import('@/app/api/admin/learning-tasks/[id]/ai-brief/route');
    const response = await POST(
      new Request('http://localhost', { method: 'POST', body: '{}' }) as NextRequest,
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(response.status).toBe(401);
    expect(callLLMMock).not.toHaveBeenCalled();
  });

  it('creates a remedial draft only after accepting a suggestion', async () => {
    const svc = service();
    getServerSupabaseMock.mockResolvedValue(auth({ id: 'teacher-1' }));
    getServiceSupabaseMock.mockReturnValue(svc);
    const { POST } =
      await import('@/app/api/admin/learning-tasks/[id]/ai-suggestions/[suggestionId]/accept/route');
    const response = await POST(
      new Request('http://localhost', { method: 'POST' }) as NextRequest,
      { params: Promise.resolve({ id: 'task-1', suggestionId: 'suggestion-1' }) },
    );
    expect(response.status).toBe(201);
    expect(svc.rpc).toHaveBeenCalledWith(
      'create_task_with_learners',
      expect.objectContaining({
        p_task_type: 'remedial',
        p_source_task_id: 'task-1',
        p_learner_ids: ['s1'],
      }),
    );
    expect((await response.json()).data).toMatchObject({ taskId: 'remedial-1', status: 'draft' });
  });
});
