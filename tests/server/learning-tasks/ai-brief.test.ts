import { describe, expect, it } from 'vitest';
import { buildAiBriefSnapshot, parseAiBrief } from '@/lib/server/learning-tasks/ai-brief';

describe('AI learning brief helpers', () => {
  it('keeps the report metrics as the deterministic source of truth', () => {
    const { report } = buildAiBriefSnapshot({
      dueAt: null,
      learners: [
        {
          studentId: 's1',
          name: '学员',
          status: 'completed',
          progressPercent: 100,
          masteryPercent: 80,
          effectiveSeconds: 60,
          lastSeenAt: null,
        },
      ],
      events: [{ student_id: 's1', event_type: 'scene_completed', scene_id: 'scene-1' }],
      scenes: [{ id: 'scene-1', title: '第一节', order: 1 }],
      generatedAt: new Date('2026-08-12T00:00:00.000Z'),
    });
    expect(report.overview).toMatchObject({ total: 1, completed: 1, effectiveSeconds: 60 });
    expect(report.chapters[0]).toMatchObject({ id: 'scene-1', completedLearners: 1 });
  });

  it('parses structured model output and does not fabricate a fallback', () => {
    expect(parseAiBrief('not json')).toBeNull();
    const parsed = parseAiBrief(
      '{"classBrief":{"headline":"班级","summary":"概览","strengths":[],"attention":[]},"learnerBriefs":[{"studentId":"s1","content":{"headline":"个人","summary":"需复习","strengths":[],"attention":["完成度"]}}],"suggestions":[{"learnerIds":["s1"],"sceneIds":["scene-1"],"reason":"补学"}]}',
    );
    expect(parsed?.learnerBriefs[0].studentId).toBe('s1');
    expect(parsed?.suggestions[0].learnerIds).toEqual(['s1']);
  });
});
