import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  loadStageData: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/utils/database', () => ({
  db: { stageOutlines: { put: vi.fn(), get: vi.fn() } },
}));

import { useStageStore } from '@/lib/store/stage';
import type { Scene, Stage } from '@/lib/types/stage';

const stage: Stage = { id: 'stage-1', name: 'Test stage', createdAt: 1, updatedAt: 1 };
const scene: Scene = {
  id: 'scene-1',
  stageId: 'stage-1',
  type: 'slide',
  title: 'Original title',
  order: 0,
  content: {
    type: 'slide',
    canvas: {
      id: 'canvas-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: { backgroundColor: '#fff', themeColors: ['#000'], fontColor: '#000', fontName: 'Inter' },
      elements: [],
    },
  },
};

beforeEach(() => {
  useStageStore.setState({
    stage,
    scenes: [scene],
    contentRevision: 0,
    cloudSavedRevision: 0,
  });
});

afterEach(() => useStageStore.getState().clearStore());

describe('course cloud-save state', () => {
  it('requires another cloud save after an edit', () => {
    useStageStore.getState().updateScene('scene-1', { title: 'Edited title' });
    expect(useStageStore.getState().contentRevision).toBe(1);
    expect(useStageStore.getState().cloudSavedRevision).toBe(0);

    useStageStore.getState().markCloudSaved();
    expect(useStageStore.getState().cloudSavedRevision).toBe(1);

    useStageStore.getState().updateStage({ name: 'Edited course title' });
    expect(useStageStore.getState().contentRevision).toBe(2);
    expect(useStageStore.getState().cloudSavedRevision).toBe(1);
  });
});
