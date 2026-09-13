import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getState: vi.fn(), setScenes: vi.fn() }));
vi.mock('@/lib/store/stage', () => ({ useStageStore: { getState: mocks.getState } }));

import { applyCourseStructureEdits } from '@/lib/agent/client/apply-course-structure';

const scenes = [
  { id: 'a', title: 'A', order: 1, updatedAt: 1 },
  { id: 'b', title: 'B', order: 2, updatedAt: 1 },
] as never[];

describe('applyCourseStructureEdits', () => {
  beforeEach(() => {
    mocks.setScenes.mockReset();
    mocks.getState.mockReturnValue({ scenes, setScenes: mocks.setScenes });
  });

  it('applies rename and reorder in one store update', () => {
    const result = applyCourseStructureEdits({
      updateCount: 2,
      operations: [
        { type: 'rename', sceneId: 'a', title: 'Intro' },
        { type: 'reorder', sceneIds: ['b', 'a'] },
      ],
    });
    expect(result).toEqual({ ok: true });
    expect(mocks.setScenes).toHaveBeenCalledOnce();
    expect(mocks.setScenes.mock.calls[0][0]).toMatchObject([
      { id: 'b', order: 1 },
      { id: 'a', title: 'Intro', order: 2 },
    ]);
  });

  it('refuses stale reorder without changing the course', () => {
    const result = applyCourseStructureEdits({
      updateCount: 1,
      operations: [{ type: 'reorder', sceneIds: ['a'] }],
    });
    expect(result.ok).toBe(false);
    expect(mocks.setScenes).not.toHaveBeenCalled();
  });
});
