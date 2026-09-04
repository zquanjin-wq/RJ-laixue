import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { compileCourseVideo } from '@/lib/video-export/compile-course-video';
import type { CourseVideoSource } from '@/lib/video-export/course-video-source';

const source: CourseVideoSource = {
  stageName: '员工入职培训',
  pages: [
    {
      id: 'scene-1',
      title: '欢迎',
      kind: 'slide',
      image: new Blob(['png'], { type: 'image/png' }),
      narration: [{ text: '欢迎参加培训。', audioRef: 'audio/welcome.mp3' }],
    },
    {
      id: 'scene-2',
      title: '练习',
      kind: 'cover',
      body: '本节包含 2 道练习题，请在课堂中完成。',
      narration: [],
    },
  ],
};

describe('compileCourseVideo', () => {
  it('builds an arbitrary-page render ZIP with snapshots, existing audio and a cover page', async () => {
    const zipBytes = await compileCourseVideo(
      source,
      async (audioRef) =>
        audioRef === 'audio/welcome.mp3'
          ? { blob: new Blob(['audio'], { type: 'audio/mpeg' }), durationMs: 3200 }
          : undefined,
      new TextEncoder().encode('window.gsap = {};'),
    );
    const zip = await JSZip.loadAsync(zipBytes);
    const paths = Object.keys(zip.files);
    const html = await zip.file('index.html')!.async('string');
    const manifest = JSON.parse(await zip.file('openmaic-video-manifest.json')!.async('string'));

    expect(paths).toEqual(
      expect.arrayContaining([
        'assets/scenes/scene-1.png',
        'assets/audio/0.media',
        'assets/vendor/gsap.min.js',
        'subtitles.srt',
        'subtitles.vtt',
      ]),
    );
    expect(html).toContain('assets/scenes/scene-1.png');
    expect(html).toContain('本节包含 2 道练习题，请在课堂中完成。');
    expect(html).toContain('assets/audio/0.media');
    expect(html).toContain(
      'id="scene-1" class="clip" data-start="0.000" data-duration="3.200" data-track-index="0"',
    );
    expect(html).toContain(
      'id="scene-1-audio-1" class="clip" data-start="0.000" data-duration="3.200" data-track-index="2"',
    );
    expect(manifest.totalDurationMs).toBe(8200);
    expect(manifest.scenes).toHaveLength(2);
    expect(await zip.file('subtitles.srt')!.async('string')).toContain('欢迎参加培训。');
  });

  it('places consecutive narration clips one after another on the audio track', async () => {
    const zipBytes = await compileCourseVideo(
      {
        ...source,
        pages: [
          {
            ...source.pages[0],
            narration: [
              { text: '第一句。', audioRef: 'audio/one.mp3' },
              { text: '第二句。', audioRef: 'audio/two.mp3' },
            ],
          },
        ],
      },
      async (audioRef) => ({
        blob: new Blob([audioRef], { type: 'audio/mpeg' }),
        durationMs: audioRef === 'audio/one.mp3' ? 1200 : 2300,
      }),
      new Uint8Array(),
    );
    const zip = await JSZip.loadAsync(zipBytes);
    const html = await zip.file('index.html')!.async('string');

    expect(html).toContain(
      'id="scene-1-audio-1" class="clip" data-start="0.000" data-duration="1.200" data-track-index="2"',
    );
    expect(html).toContain(
      'id="scene-1-audio-2" class="clip" data-start="1.200" data-duration="2.300" data-track-index="2"',
    );
  });
});
