import { describe, expect, it } from 'vitest';
import { makeEditCourseStructureTool } from '@/lib/agent/tools/edit-course-structure';
import type { SceneContext } from '@/lib/agent/tools/regenerate-scene-actions';

const ctx = { outline: { id: 'o', title: 'Page', type: 'slide', order: 1, description: '', keyPoints: [] } } as unknown as SceneContext;
const interactiveCtx = { outline: { ...ctx.outline, id: 'oi', type: 'interactive' } } as SceneContext;

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
    expect(result.details.operations).toBeNull();
  });

  it('refuses unknown scene ids', async () => {
    const result = await makeTool().execute('call', { operations: [
      { type: 'rename', sceneId: 'missing', title: 'Nope' },
    ] }, new AbortController().signal);
    expect(result.details.operations).toBeNull();
  });

  it('accepts adding, duplicating, and deleting pages while preserving one page', async () => {
    const result = await makeTool().execute('call', { operations: [
      { type: 'add_blank', afterSceneId: 'a', title: 'Practice' },
      { type: 'duplicate', sceneId: 'a', title: 'Introduction copy' },
      { type: 'delete', sceneId: 'b' },
    ] }, new AbortController().signal);
    expect(result.details.operations).not.toBeNull();
    expect(result.details).toMatchObject({ updateCount: 3 });
  });

  it('refuses deleting every page', async () => {
    const result = await makeTool().execute('call', { operations: [
      { type: 'delete', sceneId: 'a' },
      { type: 'delete', sceneId: 'b' },
    ] }, new AbortController().signal);
    expect(result.details.operations).toBeNull();
  });

  it('refuses duplicating non-slide pages', async () => {
    const tool = makeEditCourseStructureTool({ listSceneContexts: () => [['a', interactiveCtx], ['b', ctx]] });
    const result = await tool.execute('call', { operations: [
      { type: 'duplicate', sceneId: 'a' },
    ] }, new AbortController().signal);
    expect(result.details.operations).toBeNull();
  });

  it('refuses reorder mixed with membership changes', async () => {
    const result = await makeTool().execute('call', { operations: [
      { type: 'add_blank', afterSceneId: 'a' },
      { type: 'reorder', sceneIds: ['b', 'a'] },
    ] }, new AbortController().signal);
    expect(result.details.operations).toBeNull();
  });
});
