import { describe, expect, it, vi } from 'vitest';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';
import { prepareCourseVideoSource } from '@/lib/video-export/course-video-source';

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
        actions: [{ id: 'speech-1', type: 'speech', text: '欢迎参加培训。', audioRef: 'audio/welcome.mp3' } as never],
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
    expect(source.pages.map((page) => page.id)).toEqual(['scene-1', 'scene-2', 'scene-3']);
    expect(captureSlide).toHaveBeenCalledTimes(1);
    expect(source.pages[0]).toMatchObject({
      kind: 'slide',
      title: '欢迎',
      image,
      narration: [{ text: '欢迎参加培训。', audioRef: 'audio/welcome.mp3' }],
    });
  });

  it('uses honest static covers for unsupported interactive course scenes', async () => {
    const source = await prepareCourseVideoSource(manifest(), async () => new Blob());

    expect(source.pages[1]).toMatchObject({
      kind: 'cover',
      title: '检查理解',
      body: '本节包含 1 道练习题，请在课堂中完成。',
    });
    expect(source.pages[2]).toMatchObject({
      kind: 'cover',
      title: '动手练习',
      body: '本节包含互动内容，请在课堂中完成。',
    });
  });
});
