import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/usage/route';
import { requireAuthOrTeacher } from '@/lib/server/api-guard';
import { readUsageRecords, type UsageRecord } from '@/lib/server/usage-storage';

vi.mock('@/lib/server/usage-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/usage-storage')>();
  return {
    ...actual,
    readUsageRecords: vi.fn(),
  };
});

vi.mock('@/lib/server/api-guard', () => ({
  requireAuthOrTeacher: vi.fn(),
}));

describe('GET /api/usage', () => {
  beforeEach(() => {
    vi.mocked(requireAuthOrTeacher).mockResolvedValue({
      ok: true,
      user: { id: 'admin-1' },
      role: 'admin',
    });
  });

  it('requires an administrator session', async () => {
    const denied = new Response(JSON.stringify({ success: false }), { status: 401 });
    vi.mocked(requireAuthOrTeacher).mockResolvedValueOnce({
      ok: false,
      response: denied as never,
    });

    const response = await GET(new NextRequest('http://localhost/api/usage'));

    expect(response.status).toBe(401);
    expect(readUsageRecords).not.toHaveBeenCalled();
  });

  it('rejects invalid month filters before reading usage data', async () => {
    const response = await GET(new NextRequest('http://localhost/api/usage?months=2026-13'));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.errorCode).toBe('INVALID_REQUEST');
    expect(readUsageRecords).not.toHaveBeenCalled();
  });

  it('does not add cache detail fields again to displayed token totals', async () => {
    const record: UsageRecord = {
      id: '1',
      createdAt: Date.UTC(2026, 5, 29),
      kind: 'llm',
      source: 'chat',
      providerId: 'openai',
      modelId: 'gpt-x',
      modelString: 'openai:gpt-x',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
      reasoningTokens: 0,
      unit: 'token',
    };
    vi.mocked(readUsageRecords).mockResolvedValueOnce([record]);

    const response = await GET(new NextRequest('http://localhost/api/usage'));
    const body = await response.json();

    expect(body.totals.llmTokens).toBe(120);
    expect(body.byModel[0].totalTokens).toBe(120);
    expect(body.byModel[0].cacheReadTokens).toBe(30);
    expect(body.byModel[0].cacheCreationTokens).toBe(10);
  });
});
