import { describe, expect, it } from 'vitest';
import { makeReadCourseStructureTool } from '@/lib/agent/tools/read-course-structure';
import type { SceneContext } from '@/lib/agent/tools/regenerate-scene-actions';

function context(
  title: string,
  order: number,
  type: 'slide' | 'quiz' = 'slide',
): SceneContext {
  return {
    outline: {
      id: `outline-${order}`,
      title,
      order,
      type,
      description: `${title} description`,
      keyPoints: [`${title} point`],
    },
    allOutlines: [],
    content:
      type === 'slide'
        ? {
            type: 'slide',
            canvas: {
              id: `canvas-${order}`,
              viewportSize: 1000,
              viewportRatio: 0.5625,
              elements: [],
            },
          }
        : { type: 'quiz', questions: [] },
    stageId: 'course-1',
  } as SceneContext;
}

describe('read_course_structure', () => {
  it('returns the whole course in outline order and marks the active page', async () => {
    const tool = makeReadCourseStructureTool({
      activeSceneId: 'scene-b',
      listSceneContexts: () => [
        ['scene-b', context('Second', 2, 'quiz')],
        ['scene-a', context('First', 1)],
      ],
    });

    const result = await tool.execute('call-1', {}, new AbortController().signal);

    expect(result.details).toEqual({
      sceneCount: 2,
      scenes: [
        expect.objectContaining({ sceneId: 'scene-a', title: 'First', active: false }),
        expect.objectContaining({ sceneId: 'scene-b', title: 'Second', active: true }),
      ],
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('[scene-b] Second (quiz) [current]'),
    });
  });

  it('returns an explicit empty-course result', async () => {
    const tool = makeReadCourseStructureTool({ listSceneContexts: () => [] });
    const result = await tool.execute('call-1', {}, new AbortController().signal);

    expect(result.details).toEqual({ sceneCount: 0, scenes: [] });
    expect(result.content[0]).toMatchObject({ text: 'Course structure is empty.' });
  });
});
