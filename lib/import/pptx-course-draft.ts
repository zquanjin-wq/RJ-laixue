import { nanoid } from 'nanoid';
import type { Slide } from '@openmaic/dsl';
import type { Scene, Stage } from '@/lib/types/stage';

function titleFromFilename(fileName: string): string {
  return fileName.replace(/\.pptx$/i, '').trim() || '导入课件';
}

/** Turns importer output into the same formal course content read by the editor/player. */
export function createPptxCourseDraft(input: {
  courseId: string;
  fileName: string;
  slides: Slide[];
  sourceId: string;
}): { title: string; stage: Stage; scenes: Scene[]; outlines: unknown[] } {
  if (!input.slides.length) throw new Error('PPTX 中没有可导入的页面');
  const now = Date.now();
  const title = titleFromFilename(input.fileName);
  const stage: Stage = {
    id: input.courseId,
    name: title,
    description: `从 ${input.fileName} 导入`,
    style: 'interactive',
    createdAt: now,
    updatedAt: now,
  };
  const scenes = input.slides.map(
    (slide, index): Scene => ({
      id: nanoid(),
      stageId: input.courseId,
      type: 'slide',
      title: `第 ${index + 1} 页`,
      order: index,
      seq: index,
      content: { type: 'slide', canvas: slide },
      actions: [],
      createdAt: now,
      updatedAt: now,
    }),
  );
  return {
    title,
    stage: {
      ...stage,
      pptxSource: { sourceId: input.sourceId, fileName: input.fileName },
    } as Stage,
    scenes,
    outlines: [],
  };
}
