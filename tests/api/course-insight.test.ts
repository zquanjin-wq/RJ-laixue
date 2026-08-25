import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getServerSupabaseMock, getServiceSupabaseMock, callLLMMock, resolveModelMock } = vi.hoisted(
  () => ({
    getServerSupabaseMock: vi.fn(),
    getServiceSupabaseMock: vi.fn(),
    callLLMMock: vi.fn(),
    resolveModelMock: vi.fn(),
  }),
);

vi.mock('@/lib/supabase/server', () => ({
  getServerSupabase: getServerSupabaseMock,
  getServiceSupabase: getServiceSupabaseMock,
}));
vi.mock('@/lib/ai/llm', () => ({ callLLM: callLLMMock }));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: resolveModelMock }));

function server(user: { id: string; email?: string } | null) {
  return { auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) } };
}

function service(role: string, courseOwner = 'teacher-1') {
  return {
    from(table: string) {
      const rows: Record<string, unknown[]> = {
        profiles: [{ role }],
        courses: [{ id: 'course-1', title: '课程一', created_by: courseOwner }],
      };
      const data = rows[table] ?? [];
      const chain: any = Promise.resolve({ data, error: null });
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({ data: data[0] ?? null, error: null });
      return chain;
    },
  };
}

function request(body: Record<string, unknown>) {
  return new Request('http://localhost', {
    method: 'POST',
    body: JSON.stringify(body),
  }) as NextRequest;
}

afterEach(() => vi.resetAllMocks());

describe('POST /api/admin/courses/[id]/insight', () => {
  it('rejects unauthenticated requests', async () => {
    getServerSupabaseMock.mockResolvedValue(server(null));
    const { POST } = await import('@/app/api/admin/courses/[id]/insight/route');
    const response = await POST(request({}), { params: Promise.resolve({ id: 'course-1' }) });
    expect(response.status).toBe(401);
  });

  it('rejects learner-only accounts', async () => {
    getServerSupabaseMock.mockResolvedValue(server({ id: 'learner-1' }));
    getServiceSupabaseMock.mockReturnValue(service('learner'));
    const { POST } = await import('@/app/api/admin/courses/[id]/insight/route');
    const response = await POST(request({}), { params: Promise.resolve({ id: 'course-1' }) });
    expect(response.status).toBe(403);
  });

  it('only lets a course owner ask AI to interpret loaded course statistics', async () => {
    getServerSupabaseMock.mockResolvedValue(
      server({ id: 'teacher-1', email: 'teacher@example.com' }),
    );
    getServiceSupabaseMock.mockReturnValue(service('teacher'));
    resolveModelMock.mockResolvedValue({ model: { provider: 'test' }, thinkingConfig: undefined });
    callLLMMock.mockResolvedValue({ text: '建议优先关注提问较多的章节。' });
    const { POST } = await import('@/app/api/admin/courses/[id]/insight/route');
    const response = await POST(
      request({
        question: '哪里需要关注？',
        report: {
          overview: { learnerCount: 2 },
          chapters: [{ title: '第一节', questionsAsked: 1 }],
        },
      }),
      { params: Promise.resolve({ id: 'course-1' }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data.answer).toContain('提问较多');
    expect(callLLMMock.mock.calls[0][0].prompt).toContain('哪里需要关注');
  });

  it('rejects another teacher before calling the model', async () => {
    getServerSupabaseMock.mockResolvedValue(
      server({ id: 'teacher-2', email: 'teacher2@example.com' }),
    );
    getServiceSupabaseMock.mockReturnValue(service('teacher', 'teacher-1'));
    const { POST } = await import('@/app/api/admin/courses/[id]/insight/route');
    const response = await POST(request({ question: '哪里需要关注？', report: { overview: {} } }), {
      params: Promise.resolve({ id: 'course-1' }),
    });
    expect(response.status).toBe(403);
    expect(callLLMMock).not.toHaveBeenCalled();
  });
});
