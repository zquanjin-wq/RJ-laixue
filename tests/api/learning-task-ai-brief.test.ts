import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const {
  getCurrentActor,
  canManageTask,
  getSuggestion,
  getTask,
  getTaskAnalytics,
  acceptSuggestion,
  createTask,
  callLLM,
} = vi.hoisted(() => ({
  getCurrentActor: vi.fn(),
  canManageTask: vi.fn(),
  getSuggestion: vi.fn(),
  getTask: vi.fn(),
  getTaskAnalytics: vi.fn(),
  acceptSuggestion: vi.fn(),
  createTask: vi.fn(),
  callLLM: vi.fn(),
}));

vi.mock('@/lib/server/auth-context', () => ({ getCurrentActor }));
vi.mock('@/lib/server/db/pool', () => ({ getDatabasePool: vi.fn(() => ({})) }));
vi.mock('@/lib/server/db/access-repository', () => ({
  AccessRepository: class { canManageTask = canManageTask; },
}));
vi.mock('@/lib/server/db/learning-analytics-repository', () => ({
  LearningAnalyticsRepository: class {
    getSuggestion = getSuggestion;
    getTask = getTask;
    getTaskAnalytics = getTaskAnalytics;
    acceptSuggestion = acceptSuggestion;
  },
}));
vi.mock('@/lib/server/db/task-repository', () => ({
  TaskRepository: class { createTask = createTask; },
}));
vi.mock('@/lib/ai/llm', () => ({ callLLM }));

afterEach(() => vi.resetAllMocks());

describe('learning task AI brief routes', () => {
  it('requires a signed-in teacher before generating a brief', async () => {
    getCurrentActor.mockResolvedValue(null);
    const { POST } = await import('@/app/api/admin/learning-tasks/[id]/ai-brief/route');

    const response = await POST(
      new Request('http://localhost', { method: 'POST', body: '{}' }) as NextRequest,
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(response?.status).toBe(401);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('creates a remedial draft only after accepting an owned suggestion', async () => {
    getCurrentActor.mockResolvedValue({ userId: 'teacher-1', role: 'teacher' });
    canManageTask.mockResolvedValue(true);
    getSuggestion.mockResolvedValue({ id: 'suggestion-1', learner_ids: ['learner-1'], reason: '补学' });
    getTask.mockResolvedValue({ id: 'task-1', title: '原任务' });
    getTaskAnalytics.mockResolvedValue({ courses: [{ course_id: 'course-1', is_required: true }] });
    createTask.mockResolvedValue('remedial-1');
    acceptSuggestion.mockResolvedValue(true);
    const { POST } = await import('@/app/api/admin/learning-tasks/[id]/ai-suggestions/[suggestionId]/accept/route');

    const response = await POST(
      new Request('http://localhost', { method: 'POST' }) as NextRequest,
      { params: Promise.resolve({ id: 'task-1', suggestionId: 'suggestion-1' }) },
    );

    expect(response.status).toBe(201);
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: 'teacher-1',
      taskType: 'remedial',
      sourceTaskId: 'task-1',
      userIds: ['learner-1'],
    }));
    await expect(response.json()).resolves.toMatchObject({ data: { taskId: 'remedial-1', status: 'draft' } });
  });
});
