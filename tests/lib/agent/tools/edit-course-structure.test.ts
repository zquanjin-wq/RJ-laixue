import { describe, expect, it } from 'vitest';
import { makeEditCourseStructureTool } from '@/lib/agent/tools/edit-course-structure';
import type { SceneContext } from '@/lib/agent/tools/regenerate-scene-actions';

const ctx = { outline: { id: 'o', title: 'Page', type: 'slide', order: 1, description: '', keyPoints: [] } } as SceneContext;

describe('edit_course_structure', () => {
  const makeTool = () => makeEditCourseStructureTool({ listSceneContexts: () => [['a', ctx], ['b', ctx]] });

  it('accepts trusted rename and full reorder operations', async () => {
    const result = await makeTool().execute('call', { operations: [
      { type: 'rename', sceneId: 'a', title: 'Introduction' },
      { type: 'reorder', sceneIds: ['b', 'a'] },
    ] }, new AbortController().signal);
    expect(result.details).toMatchObject({ updateCount: 2 });
    expect(result.details.operations).toHaveLength(2);
  });

  it('refuses partial reorder plans', async () => {
    const result = await makeTool().execute('call', { operations: [
      { type: 'reorder', sceneIds: ['a'] },
    ] }, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.details.operations).toBeNull();
  });

  it('refuses unknown scene ids', async () => {
    const result = await makeTool().execute('call', { operations: [
      { type: 'rename', sceneId: 'missing', title: 'Nope' },
    ] }, new AbortController().signal);
    expect(result.isError).toBe(true);
  });
});
