import { describe, expect, it } from 'vitest';
import type { Slide } from '@openmaic/dsl';
import { createPptxCourseDraft } from '@/lib/import/pptx-course-draft';

const slide: Slide = {
  id: 'slide-1',
  viewportSize: 1280,
  viewportRatio: 0.5625,
  theme: {
    themeColors: ['#123456'],
    fontColor: '#000',
    fontName: 'Arial',
    backgroundColor: '#fff',
  },
  elements: [],
  script: '先提问，再解释。',
};

describe('PPTX formal course draft', () => {
  it('keeps every imported page, order and speaker notes in the editable course', () => {
    const draft = createPptxCourseDraft({
      courseId: 'course-1',
      fileName: '安全培训.pptx',
      slides: [slide, { ...slide, id: 'slide-2' }],
      sourceId: 'source-1',
    });
    expect(draft.title).toBe('安全培训');
    expect(draft.stage.id).toBe('course-1');
    expect(draft.scenes.map((scene) => scene.order)).toEqual([0, 1]);
    expect(draft.scenes[0].content.type === 'slide' && draft.scenes[0].content.canvas.script).toBe(
      '先提问，再解释。',
    );
  });

  it('rejects an empty import instead of creating an empty formal course', () => {
    expect(() =>
      createPptxCourseDraft({
        courseId: 'course-1',
        fileName: 'empty.pptx',
        slides: [],
        sourceId: 'source-1',
      }),
    ).toThrow('没有可导入');
  });
});
