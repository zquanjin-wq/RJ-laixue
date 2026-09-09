'use client';

import { slideToPng, type ResolvedSnapshotImage } from '@openmaic/renderer/snapshot';
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

async function proxyImageForSnapshot(src: string): Promise<ResolvedSnapshotImage> {
  const response = await fetch('/api/proxy-media', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: src }),
  });
  if (!response.ok) {
    throw new Error(`课程图片无法安全导出（HTTP ${response.status}）`);
  }

  const objectUrl = URL.createObjectURL(await response.blob());
  return { src: objectUrl, cleanup: () => URL.revokeObjectURL(objectUrl) };
}

async function fetchPublishedAudio(src: string): Promise<Blob | undefined> {
  const sameOrigin = src.startsWith('/');
  const response = sameOrigin
    ? await fetch(src, { credentials: 'same-origin', cache: 'no-store' })
    : await fetch('/api/proxy-media', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: src }),
      });
  if (!response.ok) return undefined;
  const blob = await response.blob();
  return blob.size > 0 ? blob : undefined;
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
      const image = await slideToPng(slide, {
        width: 1280,
        pixelRatio: 1,
        format: 'blob',
        resolveImage: proxyImageForSnapshot,
      });
      return image as Blob;
    });
  const source = await prepareCourseVideoSource(manifest, captureSlide);
  const measureAudioDuration = options.measureAudioDuration ?? readAudioDuration;
  const measuredDurations = new Map<string, Promise<number>>();
  return compileCourseVideo(
    source,
    async (audioSource) => {
      const localAudio = audioByRef.get(audioSource);
      const audio =
        localAudio ??
        (audioSource.startsWith('/') || /^https?:\/\//i.test(audioSource)
          ? { blob: await fetchPublishedAudio(audioSource) }
          : undefined);
      const audioBlob = audio?.blob;
      if (!audioBlob) return undefined;
      const duration =
        typeof localAudio?.duration === 'number' && localAudio.duration > 0
          ? localAudio.duration
          : await (measuredDurations.get(audioSource) ??
              (() => {
                const measured = measureAudioDuration(audioBlob);
                measuredDurations.set(audioSource, measured);
                return measured;
              })());
      return { blob: audioBlob, durationMs: Math.round(duration * 1000) };
    },
    gsapSource,
  );
}
