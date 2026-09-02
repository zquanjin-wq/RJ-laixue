import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getServerSupabaseMock, recordTaskLearningEventMock } = vi.hoisted(() => ({
  getServerSupabaseMock: vi.fn(),
  recordTaskLearningEventMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ getServerSupabase: getServerSupabaseMock }));
vi.mock('@/lib/server/task-learning', () => ({
  recordTaskLearningEvent: recordTaskLearningEventMock,
}));

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/learning/task-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe('POST /api/learning/task-events', () => {
  beforeEach(() => {
    getServerSupabaseMock.mockReset();
    recordTaskLearningEventMock.mockReset();
  });

  it('requires task event fields before checking the database', async () => {
    const { POST } = await import('@/app/api/learning/task-events/route');
    const response = await POST(request({ taskId: 'task-1' }));
    expect(response.status).toBe(400);
    expect(getServerSupabaseMock).not.toHaveBeenCalled();
  });

  it('uses the logged-in user and never accepts a student id', async () => {
    getServerSupabaseMock.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
    });
    recordTaskLearningEventMock.mockResolvedValue({
      ok: true,
      recorded: true,
      progressPercent: 50,
      masteryPercent: null,
      completed: false,
    });
    const { POST } = await import('@/app/api/learning/task-events/route');
    const response = await POST(
      request({
        taskId: 'task-1',
        courseId: 'course-1',
        eventType: 'scene_started',
        clientEventId: 'event-1',
        studentId: 'forged',
      }),
    );
    expect(response.status).toBe(200);
    expect(recordTaskLearningEventMock).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ taskId: 'task-1', courseId: 'course-1' }),
    );
    expect(recordTaskLearningEventMock.mock.calls[0][1]).not.toHaveProperty('studentId');
  });

  it('does not write for an unauthenticated request', async () => {
    getServerSupabaseMock.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    });
    const { POST } = await import('@/app/api/learning/task-events/route');
    const response = await POST(
      request({
        taskId: 'task-1',
        courseId: 'course-1',
        eventType: 'task_opened',
        clientEventId: 'event-1',
      }),
    );
    expect(response.status).toBe(401);
    expect(recordTaskLearningEventMock).not.toHaveBeenCalled();
  });

  it('returns the service permission result without falling back to a course event', async () => {
    getServerSupabaseMock.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
    });
    recordTaskLearningEventMock.mockResolvedValue({
      ok: false,
      error: '无权记录此学习任务',
      errorCode: 'LEARNER_NOT_ASSIGNED',
      status: 403,
    });
    const { POST } = await import('@/app/api/learning/task-events/route');
    const response = await POST(
      request({
        taskId: 'task-1',
        courseId: 'course-1',
        eventType: 'task_opened',
        clientEventId: 'event-1',
      }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).errorCode).toBe('LEARNER_NOT_ASSIGNED');
  });
});
