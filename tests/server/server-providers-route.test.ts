import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/server-providers/route';
import { requireAuthOrTeacher } from '@/lib/server/api-guard';
import { getServerProviders } from '@/lib/server/provider-config';

vi.mock('@/lib/server/api-guard', () => ({
  requireAuthOrTeacher: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', () => ({
  getServerProviders: vi.fn(() => ({})),
  getServerTTSProviders: vi.fn(() => ({})),
  getServerASRProviders: vi.fn(() => ({})),
  getServerPDFProviders: vi.fn(() => ({})),
  getServerImageProviders: vi.fn(() => ({})),
  getServerVideoProviders: vi.fn(() => ({})),
  getServerWebSearchProviders: vi.fn(() => ({})),
  getServerTokenPlan: vi.fn(() => ({ configured: false })),
  getParallelSceneConcurrency: vi.fn(() => 0),
}));

describe('GET /api/server-providers', () => {
  beforeEach(() => {
    vi.mocked(requireAuthOrTeacher).mockResolvedValue({
      ok: true,
      user: { id: 'teacher-1' },
      role: 'teacher',
    });
  });

  it('requires a signed-in user before disclosing configured providers', async () => {
    const denied = new Response(JSON.stringify({ success: false }), { status: 401 });
    vi.mocked(requireAuthOrTeacher).mockResolvedValueOnce({
      ok: false,
      response: denied as never,
    });

    const response = await GET();

    expect(response.status).toBe(401);
    expect(getServerProviders).not.toHaveBeenCalled();
  });

  it('returns configured providers to signed-in users', async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(getServerProviders).toHaveBeenCalledOnce();
  });
});
