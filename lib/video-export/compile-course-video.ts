import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import JSZip from 'jszip';
import type { CourseVideoSource, VideoSourcePage } from './course-video-source';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GSAP_PATH = resolve(__dirname, '../../scripts/video-mini-compiler/vendor/gsap.min.js');
const RENDER_WIDTH = 1280;
const RENDER_HEIGHT = 720;
const FALLBACK_PAGE_DURATION_MS = 5000;

export interface ResolvedCourseAudio {
  blob: Blob;
  durationMs: number;
}

export type ResolveCourseAudio = (audioRef: string) => Promise<ResolvedCourseAudio | undefined>;

interface TimedPage {
  page: VideoSourcePage;
  startMs: number;
  durationMs: number;
  audio: Array<{ path: string; startMs: number; durationMs: number }>;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timestamp(ms: number, separator: ',' | '.'): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainderSeconds = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainderSeconds).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}`;
}

async function buildTimedPages(source: CourseVideoSource, resolveAudio: ResolveCourseAudio, zip: JSZip) {
  const timedPages: TimedPage[] = [];
  let cursorMs = 0;
  let audioIndex = 0;

  for (const page of source.pages) {
    const audio: TimedPage['audio'] = [];
    let narrationMs = 0;
    for (const cue of page.narration) {
      if (!cue.audioRef) continue;
      const resolved = await resolveAudio(cue.audioRef);
      if (!resolved) continue;
      const path = `assets/audio/${audioIndex++}.media`;
      zip.file(path, await blobBytes(resolved.blob));
      audio.push({ path, startMs: cursorMs + narrationMs, durationMs: resolved.durationMs });
      narrationMs += resolved.durationMs;
    }
    const durationMs = narrationMs || FALLBACK_PAGE_DURATION_MS;
    timedPages.push({ page, startMs: cursorMs, durationMs, audio });
    cursorMs += durationMs;
  }

  return { timedPages, totalDurationMs: cursorMs };
}

function pageHtml(timed: TimedPage): string {
  const { page } = timed;
  const base = `<div id="${page.id}" class="scene" data-start="${(timed.startMs / 1000).toFixed(3)}" data-duration="${(timed.durationMs / 1000).toFixed(3)}" style="opacity:0;visibility:hidden">`;
  if (page.kind === 'slide') {
    return `${base}<img class="slide-image" src="${sceneImagePath(page)}" alt="${escapeHtml(page.title)}" /></div>`;
  }
  return `${base}<div class="cover-title">${escapeHtml(page.title)}</div><div class="cover-body">${escapeHtml(page.body)}</div></div>`;
}

function sceneImagePath(page: Extract<VideoSourcePage, { kind: 'slide' }>): string {
  return `assets/scenes/${page.id}.${page.image.type === 'image/svg+xml' ? 'svg' : 'png'}`;
}

function buildIndexHtml(source: CourseVideoSource, timedPages: TimedPage[], totalDurationMs: number): string {
  const totalSeconds = (totalDurationMs / 1000).toFixed(3);
  const statements = ['var tl = gsap.timeline({ paused: true });'];
  for (const timed of timedPages) {
    const second = (timed.startMs / 1000).toFixed(3);
    statements.push(`tl.set("#${timed.page.id}", { autoAlpha: 1 }, ${second});`);
    statements.push(`tl.set("#${timed.page.id}", { autoAlpha: 0 }, ${((timed.startMs + timed.durationMs) / 1000).toFixed(3)});`);
  }
  statements.push(`tl.set({}, {}, ${totalSeconds});`);

  const audioTags = timedPages.flatMap((timed) =>
    timed.audio.map(
      (audio) =>
        `<audio class="clip" data-start="${(audio.startMs / 1000).toFixed(3)}" data-duration="${(audio.durationMs / 1000).toFixed(3)}" src="${audio.path}" data-volume="1"></audio>`,
    ),
  );

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>${escapeHtml(source.stageName)} — 视频导出</title>
<style>
*{box-sizing:border-box}html,body{margin:0;background:#000}#openmaic{position:relative;width:${RENDER_WIDTH}px;height:${RENDER_HEIGHT}px;overflow:hidden;font-family:system-ui,sans-serif;color:#fff;background:#172033}.scene{position:absolute;inset:0}.slide-image{width:100%;height:100%;object-fit:contain;background:#fff}.cover-title{position:absolute;top:18%;left:10%;right:10%;font-size:48px;font-weight:700;text-align:center}.cover-body{position:absolute;top:38%;left:15%;right:15%;font-size:30px;line-height:1.6;text-align:center;white-space:pre-wrap}
</style></head><body>
<div id="openmaic" data-composition-id="openmaic" data-start="0" data-duration="${totalSeconds}" data-width="${RENDER_WIDTH}" data-height="${RENDER_HEIGHT}">
${timedPages.map(pageHtml).join('\n')}
${audioTags.join('\n')}
</div><script src="assets/vendor/gsap.min.js"></script><script>
${statements.join('\n')}
window.__openmaicVideoManifest={runtimeDiagnostics:[],manifestPath:"openmaic-video-manifest.json"};window.__timelines=window.__timelines||{};window.__timelines.openmaic=tl;
</script></body></html>`;
}

function buildManifest(source: CourseVideoSource, timedPages: TimedPage[], totalDurationMs: number): string {
  return JSON.stringify({
    schema: 'openmaic.videoTimeline',
    version: 4,
    compiler: 'rj-course-video-v0',
    stage: { id: 'classroom-export', name: source.stageName },
    canvas: { viewBox: { width: 100, height: 100 }, pixelBase: { width: 1000, height: 562.5 }, aspectRatio: '16:9' },
    config: { playbackSpeed: 1, ttsEnabled: false, whiteboardInitiallyOpen: false },
    totalDurationMs,
    scenes: timedPages.map((timed, index) => ({
      id: timed.page.id,
      index,
      title: timed.page.title,
      type: timed.page.kind === 'slide' ? 'slide' : 'cover',
      startMs: timed.startMs,
      durationMs: timed.durationMs,
      supported: true,
      base: { kind: timed.page.kind, reason: '' },
      visuals: [], narration: [], effects: [], videos: [], markers: [],
    })),
    assets: { entries: [] }, diagnostics: [],
  }, null, 2) + '\n';
}

function buildSubtitles(timedPages: TimedPage[]): { srt: string; vtt: string } {
  const cues = timedPages.flatMap((timed) => {
    if (!timed.page.narration.length) return [];
    const cueDuration = Math.floor(timed.durationMs / timed.page.narration.length);
    return timed.page.narration.map((cue, index) => ({
      text: cue.text,
      startMs: timed.startMs + cueDuration * index,
      endMs: timed.startMs + cueDuration * (index + 1),
    }));
  });
  return {
    srt: cues.map((cue, index) => `${index + 1}\n${timestamp(cue.startMs, ',')} --> ${timestamp(cue.endMs, ',')}\n${cue.text}`).join('\n\n') + (cues.length ? '\n' : ''),
    vtt: `WEBVTT\n\n${cues.map((cue) => `${timestamp(cue.startMs, '.')} --> ${timestamp(cue.endMs, '.')}\n${cue.text}`).join('\n\n')}\n`,
  };
}

/** Compile snapshot pages and their existing narration assets into a render-service ZIP. */
export async function compileCourseVideo(
  source: CourseVideoSource,
  resolveAudio: ResolveCourseAudio,
): Promise<Uint8Array> {
  const zip = new JSZip();
  const date = new Date('1980-01-01T00:00:00Z');
  const { timedPages, totalDurationMs } = await buildTimedPages(source, resolveAudio, zip);

  for (const timed of timedPages) {
    if (timed.page.kind === 'slide') {
      zip.file(sceneImagePath(timed.page), await blobBytes(timed.page.image));
    }
  }

  const subtitles = buildSubtitles(timedPages);
  zip.file('index.html', buildIndexHtml(source, timedPages, totalDurationMs), { date });
  zip.file('openmaic-video-manifest.json', buildManifest(source, timedPages, totalDurationMs), { date });
  zip.file('assets/vendor/gsap.min.js', readFileSync(GSAP_PATH), { date });
  zip.file('subtitles.srt', subtitles.srt, { date });
  zip.file('subtitles.vtt', subtitles.vtt, { date });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
