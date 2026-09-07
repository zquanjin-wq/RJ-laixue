import { describe, expect, it, vi } from 'vitest';
import { generatePptxPageScript } from '@/lib/pptx-ai-classroom/generation';

describe('PPTX narration generation', () => {
  it('uses speaker notes as a rewrite source rather than attaching raw notes as speech', async () => {
    const aiCall = vi.fn().mockResolvedValue('欢迎大家。接下来请留意这页呈现的三个关键能力。');
    const result = await generatePptxPageScript({
      courseTitle: '示例课程',
      teachingRequirement: '面向新员工解释三个关键能力，并加入一次理解检查。',
      languageDirective: 'zh-CN',
      previousTitle: '封面',
      page: {
        sceneId: 'scene-2',
        page: 2,
        title: '核心能力',
        visibleText: ['能力一', '能力二'],
        speakerNotes: '原始讲者备注，不应该直接作为最终配音。',
        repairs: [],
        warnings: [],
      },
      aiCall,
    });

    expect(result).toEqual({
      sceneId: 'scene-2',
      text: '欢迎大家。接下来请留意这页呈现的三个关键能力。',
      sourceKind: 'speaker_notes_rewritten',
    });
    expect(aiCall.mock.calls[0]?.[1]).toContain('原始讲者备注，不应该直接作为最终配音。');
    expect(aiCall.mock.calls[0]?.[1]).toContain('面向新员工解释三个关键能力');
  });
});
