import { describe, expect, it } from 'vitest';
import { validatePptxAiClassroom } from '@/lib/pptx-ai-classroom/quality';

describe('PPTX AI classroom quality validation', () => {
  const stage: any = {
    id: 'course-1',
    generatedAgentConfigs: [
      { id: 'teacher-1', role: 'teacher' },
      { id: 'student-1', role: 'student' },
    ],
    agentIds: ['teacher-1', 'student-1'],
  };

  it('accepts a playable slide with a valid cue and synthesized narration', () => {
    const report = validatePptxAiClassroom({
      stage,
      requireAudio: true,
      scenes: [{
        id: 'scene-1', order: 0, seq: 0,
        content: { type: 'slide', canvas: { elements: [{ id: 'title', type: 'text' }] } },
        actions: [
          { id: 'focus', type: 'spotlight', elementId: 'title' },
          { id: 'speech', type: 'speech', text: '欢迎学习。', audioId: 'a1', audioUrl: '/audio/a1' },
        ],
      }] as any,
    });
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(report.audioCoverage).toEqual({ required: 1, ready: 1 });
  });

  it('rejects broken action references and missing mandatory audio', () => {
    const report = validatePptxAiClassroom({
      stage,
      requireAudio: true,
      scenes: [{
        id: 'scene-1', order: 0, seq: 0,
        content: { type: 'slide', canvas: { elements: [{ id: 'title', type: 'text' }] } },
        actions: [
          { id: 'focus', type: 'spotlight', elementId: 'missing' },
          { id: 'speech', type: 'speech', text: '欢迎学习。' },
          { id: 'discussion', type: 'discussion', topic: '讨论', agentId: 'missing-agent' },
        ],
      }] as any,
    });
    expect(report.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code))
      .toEqual(expect.arrayContaining(['missing_element', 'missing_audio', 'missing_agent']));
  });
});
