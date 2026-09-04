import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getCurrentActor, recordTaskLearningEvent } = vi.hoisted(() => ({
  getCurrentActor: vi.fn(),
  recordTaskLearningEvent: vi.fn(),
}));

vi.mock('@/lib/server/auth-context', () => ({ getCurrentActor }));
vi.mock('@/lib/server/task-learning', () => ({ recordTaskLearningEvent }));

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/learning/task-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as NextRequest;
}

const validEvent = {
  taskId: 'task-1',
  courseId: 'course-1',
  eventType: 'scene_started',
  clientEventId: 'event-1',
};

afterEach(() => vi.resetAllMocks());

describe('POST /api/learning/task-events', () => {
  it('validates task event fields before authenticating', async () => {
    const { POST } = await import('@/app/api/learning/task-events/route');

    expect((await POST(request({ taskId: 'task-1' }))).status).toBe(400);
    expect(getCurrentActor).not.toHaveBeenCalled();
  });

  it('uses the authenticated user and ignores client supplied learner ids', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'user-1', role: 'learner' });
    recordTaskLearningEvent.mockResolvedValue({ ok: true, recorded: true, progressPercent: 50, masteryPercent: null, completed: false });
    const { POST } = await import('@/app/api/learning/task-events/route');

    const response = await POST(request({ ...validEvent, studentId: 'forged' }));

    expect(response.status).toBe(200);
    expect(recordTaskLearningEvent).toHaveBeenCalledWith('user-1', expect.objectContaining(validEvent));
    expect(recordTaskLearningEvent.mock.calls[0][1]).not.toHaveProperty('studentId');
  });

  it('does not write for an unauthenticated request', async () => {
    getCurrentActor.mockResolvedValue(null);
    const { POST } = await import('@/app/api/learning/task-events/route');

    expect((await POST(request(validEvent))).status).toBe(401);
    expect(recordTaskLearningEvent).not.toHaveBeenCalled();
  });

  it('returns the task service permission result directly', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'user-1', role: 'learner' });
    recordTaskLearningEvent.mockResolvedValue({ ok: false, error: 'Not assigned', errorCode: 'LEARNER_NOT_ASSIGNED', status: 403 });
    const { POST } = await import('@/app/api/learning/task-events/route');

    const response = await POST(request(validEvent));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'LEARNER_NOT_ASSIGNED' });
  });
});
