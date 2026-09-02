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

function server(user: { id: string } | null) {
  return { auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) } };
}

function service(role: string) {
  return {
    from() {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: { role }, error: null }),
      };
      return chain;
    },
  };
}

afterEach(() => vi.resetAllMocks());

describe('POST /api/admin/teaching-data-chat', () => {
  it('rejects unauthenticated requests', async () => {
    getServerSupabaseMock.mockResolvedValue(server(null));
    const { POST } = await import('@/app/api/admin/teaching-data-chat/route');
    const response = await POST(
      new Request('http://localhost', { method: 'POST', body: '{}' }) as NextRequest,
    );
    expect(response.status).toBe(401);
  });

  it('rejects learner-only accounts', async () => {
    getServerSupabaseMock.mockResolvedValue(server({ id: 'learner-1' }));
    getServiceSupabaseMock.mockReturnValue(service('learner'));
    const { POST } = await import('@/app/api/admin/teaching-data-chat/route');
    const response = await POST(
      new Request('http://localhost', { method: 'POST', body: '{}' }) as NextRequest,
    );
    expect(response.status).toBe(403);
  });
});
