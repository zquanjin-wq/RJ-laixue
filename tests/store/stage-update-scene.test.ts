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

function makeStage(): Stage {
  return { id: 'stage-1', name: 'Test stage', createdAt: 1, updatedAt: 1 };
}

function makeScene(): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Before',
    order: 1,
    updatedAt: 10,
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas-1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#000'],
          fontColor: '#000',
          fontName: 'Inter',
        },
        elements: [],
      },
    },
  };
}

beforeEach(() => {
  useStageStore.setState({
    stage: makeStage(),
    scenes: [makeScene()],
    currentSceneId: 'scene-1',
  });
});

afterEach(() => {
  useStageStore.getState().clearStore();
});

describe('updateScene persistence marker', () => {
  it('advances updatedAt whenever editable scene content changes', () => {
    useStageStore.getState().updateScene('scene-1', { title: 'After' });

    const updated = useStageStore.getState().scenes[0];
    expect(updated.title).toBe('After');
    expect(updated.updatedAt).toBeGreaterThan(10);
  });

  it('keeps the marker monotonic for consecutive edits in one millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);

    useStageStore.getState().updateScene('scene-1', { title: 'First' });
    const firstUpdatedAt = useStageStore.getState().scenes[0].updatedAt ?? 0;
    useStageStore.getState().updateScene('scene-1', { title: 'Second' });
    const secondUpdatedAt = useStageStore.getState().scenes[0].updatedAt ?? 0;

    expect(secondUpdatedAt).toBeGreaterThan(firstUpdatedAt);
  });
});
