'use client';

import { slideToPng } from '@openmaic/renderer/snapshot';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';
import { compileCourseVideo } from './compile-course-video';
import { prepareCourseVideoSource, type CaptureSlide } from './course-video-source';

export interface BrowserCourseAudio {
  blob: Blob;
  duration?: number;
}

export interface CompileBrowserCourseVideoOptions {
  captureSlide?: CaptureSlide;
  gsapSource?: Uint8Array;
  measureAudioDuration?: (blob: Blob) => Promise<number>;
}

async function readAudioDuration(blob: Blob): Promise<number> {
  const url = URL.createObjectURL(blob);
  try {
    const audio = new Audio();
    audio.preload = 'metadata';
    const duration = await new Promise<number>((resolve, reject) => {
      audio.onloadedmetadata = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) resolve(audio.duration);
        else reject(new Error('讲解音频时长无效'));
      };
      audio.onerror = () => reject(new Error('无法读取讲解音频时长'));
      audio.src = url;
    });
    return duration;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Browser bridge for the eventual export button: capture the existing PPTist
 * canvas with the app renderer, then compile those snapshots and locally held
 * TTS files into the render-service ZIP.
 */
export async function compileBrowserCourseVideo(
  manifest: ClassroomManifest,
  audioByRef: ReadonlyMap<string, BrowserCourseAudio>,
  options: CompileBrowserCourseVideoOptions = {},
): Promise<Uint8Array> {
  let gsapSource = options.gsapSource;
  if (!gsapSource) {
    const gsapResponse = await fetch('/vendor/gsap.min.js');
    if (!gsapResponse.ok) {
      throw new Error(`视频导出运行库加载失败（HTTP ${gsapResponse.status}）`);
    }
    gsapSource = new Uint8Array(await gsapResponse.arrayBuffer());
  }
  const captureSlide =
    options.captureSlide ??
    (async (slide) => {
      const image = await slideToPng(slide, { width: 1280, pixelRatio: 1, format: 'blob' });
      return image as Blob;
    });
  const source = await prepareCourseVideoSource(manifest, captureSlide);
  const measureAudioDuration = options.measureAudioDuration ?? readAudioDuration;
  const measuredDurations = new Map<string, Promise<number>>();
  return compileCourseVideo(
    source,
    async (audioRef) => {
      const audio = audioByRef.get(audioRef);
      if (!audio) return undefined;
      const duration =
        typeof audio.duration === 'number' && audio.duration > 0
          ? audio.duration
          : await (measuredDurations.get(audioRef) ??
              (() => {
                const measured = measureAudioDuration(audio.blob);
                measuredDurations.set(audioRef, measured);
                return measured;
              })());
      return { blob: audio.blob, durationMs: Math.round(duration * 1000) };
    },
    gsapSource,
  );
}
