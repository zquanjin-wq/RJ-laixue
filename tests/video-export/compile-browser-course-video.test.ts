import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileBrowserCourseVideo } from '@/lib/video-export/compile-browser-course-video';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';

afterEach(() => vi.unstubAllGlobals());

describe('compileBrowserCourseVideo', () => {
  it('downloads published cloud narration when IndexedDB has no audio blob', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('/api/course-assets/object');
      return new Response(new Blob(['published-audio'], { type: 'audio/mpeg' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const manifest: ClassroomManifest = {
      formatVersion: 1,
      exportedAt: '2026-09-09T00:00:00.000Z',
      appVersion: 'test',
      stage: { name: '云端课程', createdAt: 1, updatedAt: 1 },
      agents: [],
      mediaIndex: {},
      scenes: [
        {
          type: 'slide',
          title: '第一页',
          order: 1,
          content: { type: 'slide', canvas: { id: 'slide-1', elements: [] } as never },
          actions: [
            {
              id: 'speech-1',
              type: 'speech',
              text: '这是云端讲解。',
              audioUrl: '/api/course-assets/object?key=course.mp3',
            } as never,
          ],
        },
      ],
    };

    const bytes = await compileBrowserCourseVideo(manifest, new Map(), {
      captureSlide: async () => new Blob(['page'], { type: 'image/png' }),
      gsapSource: new Uint8Array(),
      measureAudioDuration: async () => 2.5,
    });
    const zip = await JSZip.loadAsync(bytes);
    const html = await zip.file('index.html')!.async('string');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(zip.file('assets/audio/0.media')).not.toBeNull();
    expect(html).toContain('data-duration="2.500"');
  });
});
