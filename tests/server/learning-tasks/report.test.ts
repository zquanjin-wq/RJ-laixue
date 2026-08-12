import { describe, expect, it } from 'vitest';
import { buildTaskReport } from '@/lib/server/learning-tasks/report';

describe('buildTaskReport', () => {
  it('按真实学员进度、事件和截止时间汇总', () => {
    const report = buildTaskReport({
      dueAt: '2026-08-01T00:00:00.000Z',
      now: new Date('2026-08-02T00:00:00.000Z'),
      learners: [
        {
          studentId: 's1',
          name: '张三',
          status: 'completed',
          progressPercent: 100,
          masteryPercent: 80,
          effectiveSeconds: 120,
          lastSeenAt: null,
        },
        {
          studentId: 's2',
          name: '李四',
          status: 'in_progress',
          progressPercent: 50,
          masteryPercent: null,
          effectiveSeconds: 60,
          lastSeenAt: null,
        },
        {
          studentId: 's3',
          name: '王五',
          status: 'not_started',
          progressPercent: 0,
          masteryPercent: null,
          effectiveSeconds: 0,
          lastSeenAt: null,
        },
      ],
      events: [
        { student_id: 's1', event_type: 'scene_completed', scene_id: 'slide-1' },
        { student_id: 's1', event_type: 'scene_completed', scene_id: 'slide-1' },
        { student_id: 's2', event_type: 'scene_completed', scene_id: 'slide-1' },
        { student_id: 's2', event_type: 'question_asked', scene_id: 'slide-1' },
      ],
      scenes: [{ id: 'slide-1', title: '第一节', order: 1 }],
    });

    expect(report.overview).toMatchObject({
      total: 3,
      completed: 1,
      overdue: 2,
      startRate: 67,
      completionRate: 33,
      effectiveSeconds: 180,
    });
    expect(report.chapters[0]).toMatchObject({
      completedLearners: 2,
      completionRate: 67,
      questionsAsked: 1,
    });
  });
});
