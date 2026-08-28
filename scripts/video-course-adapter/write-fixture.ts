import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';
import { compileCourseVideo } from '@/lib/video-export/compile-course-video';
import { prepareCourseVideoSource } from '@/lib/video-export/course-video-source';

function toneWav(durationMs: number): Blob {
  const sampleRate = 8000;
  const sampleCount = Math.round((durationMs / 1000) * sampleRate);
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  for (const [offset, text] of [
    [0, 'RIFF'],
    [8, 'WAVEfmt '],
    [36, 'data'],
  ] as const) {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  }
  view.setUint32(4, 36 + sampleCount * 2, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, sampleCount * 2, true);
  for (let i = 0; i < sampleCount; i += 1)
    view.setInt16(
      44 + i * 2,
      Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 1800),
      true,
    );
  return new Blob([bytes], { type: 'audio/wav' });
}

const fixtureManifest: ClassroomManifest = {
  formatVersion: 1,
  exportedAt: '2026-08-27T00:00:00.000Z',
  appVersion: 'fixture',
  stage: { name: '真实课程结构视频验证', createdAt: 1, updatedAt: 1 },
  agents: [],
  mediaIndex: { 'audio/opening.wav': { type: 'audio', format: 'wav', duration: 2 } },
  scenes: [
    {
      type: 'slide',
      title: '安全培训导言',
      order: 1,
      content: { type: 'slide', canvas: { id: 'slide-1', elements: [] } as never },
      actions: [
        {
          id: 'speech-1',
          type: 'speech',
          text: '欢迎参加安全培训。',
          audioRef: 'audio/opening.wav',
        } as never,
      ],
    },
    {
      type: 'quiz',
      title: '知识检查',
      order: 2,
      content: {
        type: 'quiz',
        questions: [
          { id: 'q1', type: 'single', question: '是否已了解？' },
          { id: 'q2', type: 'single', question: '是否愿意遵守？' },
        ],
      },
    },
    {
      type: 'interactive',
      title: '现场练习',
      order: 3,
      content: { type: 'interactive', url: 'https://example.invalid/exercise' },
    },
  ],
};

async function main(): Promise<void> {
  const outputPath = process.argv[2];
  if (!outputPath)
    throw new Error('Usage: tsx scripts/video-course-adapter/write-fixture.ts <output.zip>');

  const illustrationPath = resolve(
    process.cwd(),
    'scripts/video-mini-compiler/assets/mini-course-illustration.svg',
  );
  const snapshot = new Blob([readFileSync(illustrationPath)], { type: 'image/svg+xml' });
  const source = await prepareCourseVideoSource(fixtureManifest, async () => snapshot);
  const zip = await compileCourseVideo(
    source,
    async (audioRef) =>
      audioRef === 'audio/opening.wav' ? { blob: toneWav(2000), durationMs: 2000 } : undefined,
    readFileSync(new URL('../video-mini-compiler/vendor/gsap.min.js', import.meta.url)),
  );
  writeFileSync(outputPath, zip);
}

void main();
