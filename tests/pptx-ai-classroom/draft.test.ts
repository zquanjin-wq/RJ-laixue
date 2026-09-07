import { describe, expect, it } from 'vitest';
import { applyPptxRoster, applyPptxScriptsToScenes, scriptsFromSpeakerNotes } from '@/lib/pptx-ai-classroom/draft';

describe('PPTX AI classroom draft assembly', () => {
  it('keeps imported page content and attaches stable speech actions from speaker notes', () => {
    const scene: any = { id: 'page-1', content: { type: 'slide', canvas: { elements: [{ id: 'e1' }] } }, actions: [] };
    const scripts = scriptsFromSpeakerNotes([
      { sceneId: 'page-1', page: 1, title: '欢迎', visibleText: [], speakerNotes: '欢迎大家。', repairs: [], warnings: [] },
    ]);
    const first = applyPptxScriptsToScenes([scene], scripts);
    const second = applyPptxScriptsToScenes([scene], scripts);
    expect(first[0]!.content).toEqual(scene.content);
    expect(first[0]!.actions.find((action: any) => action.type === 'speech')).toMatchObject({
      type: 'speech',
      text: '欢迎大家。',
      title: '基于讲者备注的讲解',
    });
    expect(first[0]!.actions.find((action: any) => action.type === 'speech')?.id).toBe(
      second[0]!.actions.find((action: any) => action.type === 'speech')?.id,
    );
  });

  it('only creates element-bound cues and uses a sparse companion interaction cadence', () => {
    const pages = [1, 2, 3].map((page) => ({
      id: `page-${page}`,
      title: `第 ${page} 页`,
      content: { type: 'slide', canvas: { elements: [{ id: `text-${page}`, type: 'text' }] } },
      actions: [],
    })) as any[];
    const result = applyPptxScriptsToScenes(
      pages,
      pages.map((page) => ({ sceneId: page.id, text: '讲解', sourceKind: 'ai_generated' as const })),
      { interactionIntensity: 'standard', companionId: 'student-1' },
    );
    expect(result[0]!.actions[0]).toMatchObject({ type: 'spotlight', elementId: 'text-1' });
    expect(result[2]!.actions.at(-1)).toMatchObject({ type: 'discussion', agentId: 'student-1' });
  });

  it('requires exactly one AI teacher in the persisted roster', () => {
    const stage: any = { id: 'course-1', name: '课程', createdAt: 1, updatedAt: 1 };
    expect(() => applyPptxRoster(stage, [])).toThrow('exactly one teacher');
    const updated = applyPptxRoster(stage, [
      { id: 'teacher-1', name: '林老师', role: 'teacher', persona: '清晰讲解', avatar: 'a', color: '#000', priority: 10 },
      { id: 'student-1', name: '陈同学', role: 'student', persona: '主动提问', avatar: 'b', color: '#111', priority: 5 },
    ]);
    expect(updated.generatedAgentConfigs).toHaveLength(2);
    expect(updated.agentIds).toEqual(['teacher-1', 'student-1']);
  });
});
