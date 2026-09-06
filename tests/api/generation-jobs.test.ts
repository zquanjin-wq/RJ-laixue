import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  pool: vi.fn(),
  enqueue: vi.fn(),
  resolveModel: vi.fn(),
  limit: vi.fn(),
}));

vi.mock('@/lib/server/auth-context', () => ({ getCurrentActor: mocks.actor }));
vi.mock('@/lib/server/db/pool', () => ({ getDatabasePool: mocks.pool }));
vi.mock('@/lib/server/api-guard', () => ({ rateLimitByUser: mocks.limit }));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/server/db/classroom-generation-repository', () => ({
  ClassroomGenerationRepository: class {
    enqueue = mocks.enqueue;
  },
  GenerationIdempotencyConflict: class GenerationIdempotencyConflict extends Error {},
}));

const enabledBefore = process.env.CLASSROOM_GENERATION_ENABLED;

function request(body: unknown, key?: string) {
  return new NextRequest('http://localhost/api/generation-jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body),
  });
}

describe('durable generation job submission', () => {
  beforeEach(() => {
    process.env.CLASSROOM_GENERATION_ENABLED = 'true';
    mocks.actor.mockResolvedValue({ userId: 'teacher-1', role: 'teacher' });
    mocks.limit.mockReturnValue({ ok: true });
    mocks.resolveModel.mockResolvedValue({
      modelString: 'openai/gpt-test',
      thinkingConfig: { enabled: true },
    });
    mocks.enqueue.mockResolvedValue({
      id: 'd8db3a3f-6db5-4e6a-a8d6-b586270219d4',
      courseId: 'course-1',
      reused: false,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (enabledBefore === undefined) delete process.env.CLASSROOM_GENERATION_ENABLED;
    else process.env.CLASSROOM_GENERATION_ENABLED = enabledBefore;
  });

  it('stays unavailable until the operator enables the new path', async () => {
    process.env.CLASSROOM_GENERATION_ENABLED = 'false';
    const { POST } = await import('@/app/api/generation-jobs/route');
    const response = await POST(request({ requirement: '课程' }, 'key-1'));
    expect(response.status).toBe(503);
    expect(mocks.actor).not.toHaveBeenCalled();
  });

  it('requires an authenticated author and a stable idempotency key', async () => {
    const { POST } = await import('@/app/api/generation-jobs/route');
    mocks.actor.mockResolvedValueOnce(null);
    expect((await POST(request({ requirement: '课程' }, 'key-1'))).status).toBe(401);
    expect((await POST(request({ requirement: '课程' }))).status).toBe(400);
    mocks.actor.mockResolvedValueOnce({ userId: 'learner-1', role: 'learner' });
    expect((await POST(request({ requirement: '课程' }, 'key-2'))).status).toBe(403);
  });

  it('stores only normalized request and non-secret model configuration', async () => {
    const { POST } = await import('@/app/api/generation-jobs/route');
    const response = await POST(
      request({ requirement: '  新员工入职  ', agentMode: 'default' }, 'key-3'),
    );
    expect(response.status).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: 'teacher-1',
        payload: { requirement: '新员工入职', agentMode: 'default' },
        configSnapshot: {
          pipelineVersion: 1,
          model: { modelString: 'openai/gpt-test', thinkingConfig: { enabled: true } },
        },
      }),
    );
    expect(await response.json()).toMatchObject({ courseId: 'course-1', reused: false });
  });
});
