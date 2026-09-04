import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getCurrentActorMock } = vi.hoisted(() => ({ getCurrentActorMock: vi.fn() }));
vi.mock('@/lib/server/auth-context', () => ({ getCurrentActor: getCurrentActorMock }));

afterEach(() => vi.resetAllMocks());

describe('POST /api/admin/teaching-data-chat', () => {
  it('rejects unauthenticated requests', async () => {
    getCurrentActorMock.mockResolvedValue(null);
    const { POST } = await import('@/app/api/admin/teaching-data-chat/route');
    const response = await POST(new Request('http://localhost', { method: 'POST', body: '{}' }) as NextRequest);
    expect(response.status).toBe(401);
  });

  it('rejects learner-only accounts', async () => {
    getCurrentActorMock.mockResolvedValue({ userId: 'learner-1', role: 'learner' });
    const { POST } = await import('@/app/api/admin/teaching-data-chat/route');
    const response = await POST(new Request('http://localhost', { method: 'POST', body: '{}' }) as NextRequest);
    expect(response.status).toBe(403);
  });
});
