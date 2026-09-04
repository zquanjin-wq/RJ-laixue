import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getCurrentActor, recordTaskLearningEvent } = vi.hoisted(() => ({
  getCurrentActor: vi.fn(),
  recordTaskLearningEvent: vi.fn(),
}));

vi.mock('@/lib/server/auth-context', () => ({ getCurrentActor }));
vi.mock('@/lib/server/task-learning', () => ({ recordTaskLearningEvent }));

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/learning/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as NextRequest;
}

afterEach(() => vi.resetAllMocks());

describe('POST /api/learning/events', () => {
  it('rejects unauthenticated requests without writing', async () => {
    getCurrentActor.mockResolvedValue(null);
    const { POST } = await import('@/app/api/learning/events/route');

    expect((await POST(request({ taskId: 'task-1', courseId: 'course-1', eventType: 'open_course' }))).status).toBe(401);
    expect(recordTaskLearningEvent).not.toHaveBeenCalled();
  });

  it('does not track legacy direct-course events', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'learner-1', role: 'learner' });
    const { POST } = await import('@/app/api/learning/events/route');

    const response = await POST(request({ courseId: 'course-1', eventType: 'open_course' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ recorded: false, reason: 'direct_course_events_not_tracked' });
    expect(recordTaskLearningEvent).not.toHaveBeenCalled();
  });

  it('maps legacy event names to task events for the authenticated user', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'learner-1', role: 'learner' });
    recordTaskLearningEvent.mockResolvedValue({ ok: true, recorded: true, progressPercent: 25, masteryPercent: null, completed: false });
    const { POST } = await import('@/app/api/learning/events/route');

    const response = await POST(request({ taskId: 'task-1', courseId: 'course-1', eventType: 'view_scene', sceneId: 'scene-1', studentId: 'forged' }));

    expect(response.status).toBe(200);
    expect(recordTaskLearningEvent).toHaveBeenCalledWith('learner-1', expect.objectContaining({ eventType: 'scene_started', sceneId: 'scene-1' }));
    expect(recordTaskLearningEvent.mock.calls[0][1]).not.toHaveProperty('studentId');
  });

  it('returns task service permission failures without falling back to course assignments', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'learner-1', role: 'learner' });
    recordTaskLearningEvent.mockResolvedValue({ ok: false, error: 'Not assigned', errorCode: 'LEARNER_NOT_ASSIGNED', status: 403 });
    const { POST } = await import('@/app/api/learning/events/route');

    const response = await POST(request({ taskId: 'task-1', courseId: 'course-1', eventType: 'complete_course' }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'LEARNER_NOT_ASSIGNED' });
  });
});
