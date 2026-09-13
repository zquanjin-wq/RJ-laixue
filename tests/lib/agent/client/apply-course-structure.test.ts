import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getState: vi.fn(), setScenes: vi.fn(), setCurrentSceneId: vi.fn() }));
vi.mock('@/lib/store/stage', () => ({ useStageStore: { getState: mocks.getState } }));

import { applyCourseStructureEdits } from '@/lib/agent/client/apply-course-structure';

const slideContent = { type: 'slide', schemaVersion: 1, canvas: {
  id: 'canvas-a', viewportSize: 1000, viewportRatio: 0.5625,
  theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: 'Arial' },
  elements: [], background: { type: 'solid', color: '#fff' },
} };
const scenes = [
  { id: 'a', stageId: 'stage', type: 'slide', title: 'A', order: 1, updatedAt: 1, createdAt: 1, content: slideContent, actions: [] },
  { id: 'b', stageId: 'stage', type: 'slide', title: 'B', order: 2, updatedAt: 1, createdAt: 1, content: slideContent, actions: [] },
] as never[];

describe('applyCourseStructureEdits', () => {
  beforeEach(() => {
    mocks.setScenes.mockReset();
    mocks.setCurrentSceneId.mockReset();
    mocks.getState.mockReturnValue({
      stage: { id: 'stage' }, scenes, currentSceneId: 'a',
      setScenes: mocks.setScenes, setCurrentSceneId: mocks.setCurrentSceneId,
    });
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

  it('adds a blank slide after an anchor and selects it', () => {
    const result = applyCourseStructureEdits({
      updateCount: 1,
      operations: [{ type: 'add_blank', afterSceneId: 'a', title: 'Practice' }],
    });
    expect(result).toEqual({ ok: true });
    const saved = mocks.setScenes.mock.calls[0][0];
    expect(saved).toHaveLength(3);
    expect(saved[1]).toMatchObject({ stageId: 'stage', type: 'slide', title: 'Practice', order: 2 });
    expect(mocks.setCurrentSceneId).toHaveBeenCalledWith(saved[1].id);
  });

  it('duplicates a slide with new ids and selects the copy', () => {
    const result = applyCourseStructureEdits({
      updateCount: 1,
      operations: [{ type: 'duplicate', sceneId: 'a', title: 'A copy' }],
    });
    expect(result).toEqual({ ok: true });
    const saved = mocks.setScenes.mock.calls[0][0];
    expect(saved[1]).toMatchObject({ type: 'slide', title: 'A copy', order: 2 });
    expect(saved[1].id).not.toBe('a');
    expect(saved[1].content.canvas.id).not.toBe('canvas-a');
    expect(mocks.setCurrentSceneId).toHaveBeenCalledWith(saved[1].id);
  });

  it('deletes the active page, selects its successor, and keeps contiguous order', () => {
    const result = applyCourseStructureEdits({
      updateCount: 1,
      operations: [{ type: 'delete', sceneId: 'a' }],
    });
    expect(result).toEqual({ ok: true });
    expect(mocks.setScenes.mock.calls[0][0]).toMatchObject([{ id: 'b', order: 1 }]);
    expect(mocks.setCurrentSceneId).toHaveBeenCalledWith('b');
  });

  it('refuses to delete the final page', () => {
    mocks.getState.mockReturnValue({
      stage: { id: 'stage' }, scenes: [scenes[0]], currentSceneId: 'a',
      setScenes: mocks.setScenes, setCurrentSceneId: mocks.setCurrentSceneId,
    });
    const result = applyCourseStructureEdits({
      updateCount: 1,
      operations: [{ type: 'delete', sceneId: 'a' }],
    });
    expect(result.ok).toBe(false);
    expect(mocks.setScenes).not.toHaveBeenCalled();
  });
});
