import { describe, expect, it, vi } from 'vitest';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';
import {
  planCourseVideoExport,
  prepareCourseVideoSource,
} from '@/lib/video-export/course-video-source';

const slide = { id: 'canvas-1', elements: [] };

function manifest(): ClassroomManifest {
  return {
    formatVersion: 1,
    exportedAt: '2026-08-27T00:00:00.000Z',
    appVersion: 'test',
    stage: { name: '真实课堂样例', createdAt: 1, updatedAt: 1 },
    agents: [],
    mediaIndex: { 'audio/welcome.mp3': { type: 'audio', format: 'mp3', duration: 4 } },
    scenes: [
      {
        type: 'quiz',
        title: '检查理解',
        order: 2,
        content: { type: 'quiz', questions: [{ id: 'q1', type: 'single', question: '对吗？' }] },
      },
      {
        type: 'slide',
        title: '欢迎',
        order: 1,
        content: { type: 'slide', canvas: slide as never },
        actions: [
          {
            id: 'speech-1',
            type: 'speech',
            text: '欢迎参加培训。',
            audioRef: 'audio/welcome.mp3',
          } as never,
        ],
      },
      {
        type: 'interactive',
        title: '动手练习',
        order: 3,
        content: { type: 'interactive', url: 'https://example.invalid/training' },
      },
    ],
  };
}

describe('prepareCourseVideoSource', () => {
  it('snapshots real slide scenes in display order and keeps their narration', async () => {
    const image = new Blob(['slide-png'], { type: 'image/png' });
    const captureSlide = vi.fn(async () => image);

    const source = await prepareCourseVideoSource(manifest(), captureSlide);

    expect(source.stageName).toBe('真实课堂样例');
    expect(source.pages.map((page) => page.id)).toEqual(['scene-1']);
    expect(captureSlide).toHaveBeenCalledTimes(1);
    expect(source.pages[0]).toMatchObject({
      kind: 'slide',
      title: '欢迎',
      image,
      narration: [{ text: '欢迎参加培训。', audioRef: 'audio/welcome.mp3' }],
    });
  });

  it('skips learner-interaction scenes instead of putting them on the render timeline', async () => {
    const source = await prepareCourseVideoSource(manifest(), async () => new Blob());

    expect(source.pages).toHaveLength(1);
    expect(source.pages[0].title).toBe('欢迎');
  });

  it('plans included and skipped pages before any snapshot or audio work starts', () => {
    const plan = planCourseVideoExport(manifest());

    expect(plan).toMatchObject({ totalScenes: 3, includedCount: 1, skippedCount: 2 });
    expect(plan.skippedScenes).toEqual([
      expect.objectContaining({ order: 2, title: '检查理解', reason: 'Quiz 需要学员作答' }),
      expect.objectContaining({ order: 3, title: '动手练习', reason: '互动内容需要学员操作' }),
    ]);
  });

  it('skips a slide whose timeline enters a learner discussion', () => {
    const withDiscussion: ClassroomManifest = {
      ...manifest(),
      scenes: [
        {
          type: 'slide',
          title: '小组讨论',
          order: 1,
          content: { type: 'slide', canvas: slide as never },
          actions: [{ id: 'd1', type: 'discussion', topic: '请分享观点' } as never],
        },
      ],
    };

    expect(planCourseVideoExport(withDiscussion).skippedScenes[0].reason).toBe(
      '讨论环节需要学员参与',
    );
  });
});
