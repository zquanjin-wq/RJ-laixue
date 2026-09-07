import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  pool: vi.fn(),
  enqueue: vi.fn(),
  resolveModel: vi.fn(),
  limit: vi.fn(),
  getSource: vi.fn(),
  getCourse: vi.fn(),
  retry: vi.fn(),
  getOwned: vi.fn(),
}));

vi.mock('@/lib/server/auth-context', () => ({ getCurrentActor: mocks.actor }));
vi.mock('@/lib/server/db/pool', () => ({ getDatabasePool: mocks.pool }));
vi.mock('@/lib/server/api-guard', () => ({ rateLimitByUser: mocks.limit }));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/server/db/classroom-generation-repository', () => ({
  ClassroomGenerationRepository: class {
    enqueue = mocks.enqueue;
    retry = mocks.retry;
    getOwned = mocks.getOwned;
  },
  GenerationIdempotencyConflict: class GenerationIdempotencyConflict extends Error {},
}));
vi.mock('@/lib/server/db/pptx-source-repository', () => ({
  PptxSourceRepository: class {
    getOwned = mocks.getSource;
  },
}));
vi.mock('@/lib/server/db/course-repository', () => ({
  CourseRepository: class {
    getCourse = mocks.getCourse;
  },
}));

const enabledBefore = process.env.CLASSROOM_GENERATION_ENABLED;
const pptxEnabledBefore = process.env.PPTX_AI_CLASSROOM_ENABLED;

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
    process.env.PPTX_AI_CLASSROOM_ENABLED = 'true';
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
    mocks.getSource.mockResolvedValue({ id: '64fd0314-2f09-497d-bc0b-d7f6771b04bd' });
    mocks.getCourse.mockResolvedValue({
      ownerUserId: 'teacher-1',
      contentRevision: 3,
      content: { stage: { pptxSource: { sourceId: '64fd0314-2f09-497d-bc0b-d7f6771b04bd' } } },
    });
    mocks.getOwned.mockResolvedValue({
      id: 'd8db3a3f-6db5-4e6a-a8d6-b586270219d4',
      status: 'queued',
      courseId: '6c2195f4-d03c-4cf3-9cb9-dabc17d7d343',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (enabledBefore === undefined) delete process.env.CLASSROOM_GENERATION_ENABLED;
    else process.env.CLASSROOM_GENERATION_ENABLED = enabledBefore;
    if (pptxEnabledBefore === undefined) delete process.env.PPTX_AI_CLASSROOM_ENABLED;
    else process.env.PPTX_AI_CLASSROOM_ENABLED = pptxEnabledBefore;
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

  it('queues PPT AI classroom enhancement against the existing source revision', async () => {
    const { POST } = await import('@/app/api/generation-jobs/route');
    const response = await POST(
      request(
        {
          sourceId: '64fd0314-2f09-497d-bc0b-d7f6771b04bd',
          courseId: '6c2195f4-d03c-4cf3-9cb9-dabc17d7d343',
          sourceRevision: 3,
          teachingRequirement: '向一线销售讲清 AI Learning 的价值，并设置轻量互动。',
          interactionIntensity: 'light',
          enableTTS: true,
        },
        'pptx-key-1',
      ),
    );
    expect(response.status).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'enhance',
        inputKind: 'pptx',
        pipelineKind: 'pptx_ai_classroom',
        courseId: '6c2195f4-d03c-4cf3-9cb9-dabc17d7d343',
        sourceRevision: 3,
        payload: expect.objectContaining({
          teachingRequirement: '向一线销售讲清 AI Learning 的价值，并设置轻量互动。',
          interactionIntensity: 'light',
          enableTTS: true,
        }),
      }),
    );
  });

  it('requeues a terminal job through the owner-bound retry endpoint', async () => {
    mocks.getOwned.mockResolvedValueOnce({
      id: 'd8db3a3f-6db5-4e6a-a8d6-b586270219d4', status: 'failed', courseId: 'course-1',
    });
    mocks.retry.mockResolvedValue(true);
    const { POST } = await import('@/app/api/generation-jobs/[jobId]/route');
    const response = await POST(
      new NextRequest('http://localhost/api/generation-jobs/d8db3a3f-6db5-4e6a-a8d6-b586270219d4', { method: 'POST' }),
      { params: Promise.resolve({ jobId: 'd8db3a3f-6db5-4e6a-a8d6-b586270219d4' }) },
    );
    expect(response.status).toBe(202);
    expect(mocks.retry).toHaveBeenCalledWith('d8db3a3f-6db5-4e6a-a8d6-b586270219d4', 'teacher-1');
  });
});
