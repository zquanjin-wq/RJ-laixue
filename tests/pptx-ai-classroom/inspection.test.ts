import { describe, expect, it } from 'vitest';
import { applyPptxSafeTitleRepairs, inspectImportedPptxPages } from '@/lib/pptx-ai-classroom/inspection';

const scene = (title: string, elements: unknown[], script?: string) =>
  ({
    id: 'scene-1',
    stageId: 'course-1',
    type: 'slide',
    title,
    order: 0,
    seq: 0,
    content: {
      type: 'slide',
      canvas: { id: 'slide-1', elements, ...(script ? { script } : {}) },
    },
    actions: [],
    createdAt: 1,
    updatedAt: 1,
  }) as any;

describe('imported PPTX page inspection', () => {
  it('derives a safe page title from visible text without touching the canvas', () => {
    const pages = [scene('第 1 页', [{ type: 'text', content: '  新员工入职培训  ' }], '欢迎加入。')];
    const inspected = inspectImportedPptxPages(pages);
    expect(inspected[0]).toMatchObject({
      title: '新员工入职培训',
      speakerNotes: '欢迎加入。',
      repairs: [{ reason: 'placeholder_title', confidence: 'safe' }],
    });
    const repaired = applyPptxSafeTitleRepairs(pages, inspected);
    expect(repaired[0].title).toBe('新员工入职培训');
    expect(repaired[0].content.canvas.elements).toEqual(pages[0].content.canvas.elements);
  });

  it('only normalizes a supplied title and reports pages with no teachable content', () => {
    const pages = [scene('  课程目标&nbsp; ', [])];
    const inspected = inspectImportedPptxPages(pages);
    expect(inspected[0].repairs).toEqual([
      expect.objectContaining({ after: '课程目标', reason: 'normalize_whitespace' }),
    ]);
    expect(inspected[0].warnings).toContain('未识别到可讲授文本或讲者备注。');
  });
});
