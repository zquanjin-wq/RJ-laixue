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
    const gsapResponse = await fetch('/vendor/video-export/gsap.min.js');
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
  return compileCourseVideo(
    source,
    async (audioRef) => {
      const audio = audioByRef.get(audioRef);
      return audio
        ? { blob: audio.blob, durationMs: Math.round((audio.duration ?? 0) * 1000) }
        : undefined;
    },
    gsapSource,
  );
}
