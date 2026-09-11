import { describe, expect, it, vi } from 'vitest';
import {
  generatePptxPageActions,
  sanitizePptxPageActions,
} from '@/lib/pptx-ai-classroom/actions';

describe('PPTX action generation adapter', () => {
  it('keeps the prepared narration and only accepts cues for real slide elements', async () => {
    const aiCall = vi.fn().mockResolvedValue(
      JSON.stringify([
        { type: 'action', name: 'spotlight', params: { elementId: 'real-title' } },
        { type: 'text', content: '模型临时讲稿，不能覆盖已准备讲稿。' },
      ]),
    );
    const actions = await generatePptxPageActions({
      scene: {
        id: 'scene-1',
        outlineId: 'page-1',
        title: '第一页',
        order: 0,
        content: {
          type: 'slide',
          canvas: { elements: [{ id: 'real-title', type: 'text', content: '<p>课程标题</p>' }] },
        },
        actions: [],
      } as any,
      inspection: {
        sceneId: 'scene-1', page: 1, title: '课程标题', visibleText: ['课程标题'], speakerNotes: null,
        repairs: [], warnings: [],
      },
      script: { sceneId: 'scene-1', text: '这是经过教学需求约束的最终讲稿。', sourceKind: 'ai_generated' },
      pageIndex: 0,
      allTitles: ['课程标题'],
      previousSpeeches: [],
      roster: [
        { id: 'teacher-1', name: '老师', role: 'teacher', persona: '清晰讲解', avatar: 'a', color: '#000', priority: 10 },
        { id: 'student-1', name: '同学', role: 'student', persona: '主动提问', avatar: 'b', color: '#111', priority: 5 },
      ],
      languageDirective: 'zh-CN',
      interactionIntensity: 'standard',
      aiCall,
    });

    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'spotlight', elementId: 'real-title' }),
      expect.objectContaining({ type: 'speech', text: '这是经过教学需求约束的最终讲稿。' }),
    ]));
    expect(actions.find((action) => action.type === 'speech')).not.toMatchObject({
      text: '模型临时讲稿，不能覆盖已准备讲稿。',
    });
  });

  it('repairs stale checkpoint actions without removing playable narration', () => {
    const scene = {
      id: 'scene-1',
      content: {
        type: 'slide',
        canvas: { elements: [{ id: 'real-title', type: 'text', content: '<p>课程标题</p>' }] },
      },
    } as any;
    const actions = sanitizePptxPageActions(
      scene,
      [{ id: 'teacher-1' }, { id: 'student-1' }],
      [
        { id: 'speech-1', type: 'speech', title: '讲解', text: '保留讲稿' },
        { id: 'cue-1', type: 'spotlight', elementId: 'missing-element' },
        { id: 'cue-2', type: 'spotlight', elementId: 'real-title' },
        { id: 'talk-1', type: 'discussion', agentId: 'missing-agent', message: '无效互动' },
      ] as any,
    );

    expect(actions).toEqual([
      expect.objectContaining({ type: 'speech', text: '保留讲稿' }),
      expect.objectContaining({ type: 'spotlight', elementId: 'real-title' }),
    ]);
  });
});
