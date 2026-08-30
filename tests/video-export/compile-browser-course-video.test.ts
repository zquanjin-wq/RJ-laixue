import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';
import { compileBrowserCourseVideo } from '@/lib/video-export/compile-browser-course-video';

const manifest: ClassroomManifest = {
  formatVersion: 1,
  exportedAt: '2026-08-27T00:00:00.000Z',
  appVersion: 'test',
  stage: { name: '浏览器桥接', createdAt: 1, updatedAt: 1 },
  agents: [],
  mediaIndex: {},
  scenes: [
    {
      type: 'slide',
      title: '当前课件页面',
      order: 1,
      content: { type: 'slide', canvas: { id: 'slide', elements: [] } as never },
      actions: [
        {
          id: 'speech',
          type: 'speech',
          text: '当前页面讲解。',
          audioRef: 'audio/current.wav',
        } as never,
      ],
    },
  ],
};

describe('compileBrowserCourseVideo', () => {
  it('uses the supplied canvas capture and existing local audio reference', async () => {
    const captureSlide = vi.fn(async () => new Blob(['snapshot'], { type: 'image/png' }));
    const zipBytes = await compileBrowserCourseVideo(
      manifest,
      new Map([['audio/current.wav', { blob: new Blob(['audio']), duration: 2 }]]),
      { captureSlide, gsapSource: new TextEncoder().encode('window.gsap = {};') },
    );
    const zip = await JSZip.loadAsync(zipBytes);

    expect(captureSlide).toHaveBeenCalledTimes(1);
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining(['assets/scenes/scene-1.png', 'assets/audio/0.media']),
    );
  });

  it('measures legacy audio without a stored duration before building the timeline', async () => {
    const measureAudioDuration = vi.fn(async () => 2.5);
    const zipBytes = await compileBrowserCourseVideo(
      manifest,
      new Map([['audio/current.wav', { blob: new Blob(['audio']) }]]),
      {
        captureSlide: async () => new Blob(['snapshot'], { type: 'image/png' }),
        gsapSource: new TextEncoder().encode('window.gsap = {};'),
        measureAudioDuration,
      },
    );
    const zip = await JSZip.loadAsync(zipBytes);
    const html = await zip.file('index.html')!.async('string');

    expect(measureAudioDuration).toHaveBeenCalledTimes(1);
    expect(html).toContain('data-duration="2.500" data-track-index="2"');
  });
});
