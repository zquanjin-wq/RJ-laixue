/**
 * scripts/video-mini-compiler/compile.ts — minimal two-page text course compiler.
 *
 * **Scope (S3, V0.0 最小切片).**
 *  - Input: exactly two pages of Chinese text (`title` + `body` + `durationMs`).
 *  - Output: a ZIP that `render-service` v0.3.2 accepts.
 *  - ZIP contents (all required by render-service's unzip + producer):
 *      index.html                    — paused GSAP timeline, `window.__timelines` set
 *      openmaic-video-manifest.json   — VideoTimeline-shaped manifest
 *      assets/vendor/gsap.min.js      — vendored GSAP (no CDN)
 *
 * **Out of scope.** KaTeX, Noto CJK, spotlight, Quiz/PBL, video clips, IR
 * validation (zod), runtime wiring, AppSurface glue. Each is a later S3.x
 * task.
 *
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import JSZip from 'jszip';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GSAP_PATH = resolve(__dirname, 'vendor/gsap.min.js');
const SAMPLE_IMAGE_PATH = resolve(__dirname, 'assets/mini-course-illustration.svg');
const SAMPLE_IMAGE_ZIP_PATH = 'assets/images/mini-course-illustration.svg';
const SAMPLE_AUDIO_ZIP_PATH = 'assets/audio/two-page-tone.wav';

/** Public input — exactly two pages. */
export interface MiniPage {
  /** Page title shown on the scene and in the manifest. */
  title: string;
  /** Page body shown as the cue text. Multi-line is fine; will be normalized. */
  body: string;
  /** Page duration in milliseconds; cue spans this duration. */
  durationMs: number;
}

export interface MiniCourse {
  /** Stage id, used in manifest.stage.id (stable across recompiles). */
  stageId: string;
  /** Stage name, shown in <title>. */
  stageName: string;
  /** Exactly two pages. The compiler fails if length !== 2. */
  pages: [MiniPage, MiniPage];
}

/** OpenMAIC v0.3.2 IR constants. Hard-coded to match upstream. */
const VIDEO_TIMELINE_SCHEMA = 'openmaic.videoTimeline';
const VIDEO_TIMELINE_VERSION = 4;
const VIDEO_TIMELINE_COMPILER = 'openmaic-video-timeline-mini';

const CANVAS_VIEWBOX_W = 100;
const CANVAS_VIEWBOX_H = 100;
const CANVAS_PIXEL_W = 1000;
const CANVAS_PIXEL_H = 562.5;
const CANVAS_ASPECT = '16:9';

/** Default render dimensions (matches upstream DEFAULT_WIDTH). */
const RENDER_W = 1280;
const RENDER_H = Math.round(RENDER_W * (CANVAS_PIXEL_H / CANVAS_PIXEL_W));

/** Escape `& < > "` for embedding in HTML text + double-quoted attribute values. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A tiny, self-generated WAV: 440Hz for page one, 660Hz for page two. */
function createTwoPageToneWav(totalDurationMs: number, firstPageDurationMs: number): Uint8Array {
  const sampleRate = 8000;
  const sampleCount = Math.round((totalDurationMs / 1000) * sampleRate);
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeText(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, sampleCount * 2, true);

  const firstSamples = Math.round((firstPageDurationMs / 1000) * sampleRate);
  for (let i = 0; i < sampleCount; i += 1) {
    const frequency = i < firstSamples ? 440 : 660;
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 2200);
    view.setInt16(44 + i * 2, sample, true);
  }
  return bytes;
}

function toSrtTimestamp(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainderSeconds = seconds % 60;
  const milliseconds = ms % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainderSeconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

function toVttTimestamp(ms: number): string {
  return toSrtTimestamp(ms).replace(',', '.');
}

function buildSubtitles(course: MiniCourse): { srt: string; vtt: string } {
  const firstEnd = course.pages[0].durationMs;
  const totalEnd = firstEnd + course.pages[1].durationMs;
  const cues = [
    { start: 0, end: firstEnd, text: '第一页：渲染管线总览。' },
    { start: firstEnd, end: totalEnd, text: '第二页：输出资料合同。' },
  ];
  const srt = cues
    .map((cue, index) => `${index + 1}\n${toSrtTimestamp(cue.start)} --> ${toSrtTimestamp(cue.end)}\n${cue.text}`)
    .join('\n\n') + '\n';
  const vtt = `WEBVTT\n\n${cues
    .map((cue) => `${toVttTimestamp(cue.start)} --> ${toVttTimestamp(cue.end)}\n${cue.text}`)
    .join('\n\n')}\n`;
  return { srt, vtt };
}

function buildIndexHtml(course: MiniCourse, totalDurationMs: number): string {
  const scene1 = course.pages[0];
  const scene2 = course.pages[1];
  const scene1Start = 0;
  const scene2Start = scene1.durationMs;
  const totalSec = (totalDurationMs / 1000).toFixed(4);

  const style = `  * { box-sizing: border-box; }\n  html, body { margin: 0; padding: 0; background: #000; }\n  #openmaic { font-family: system-ui, sans-serif; color: #f5f5f5; }\n  .clip-title { position: absolute; top: 6%; left: 0; width: 100%; text-align: center; font-size: 2.4vw; font-weight: 700; }\n  .clip-body { position: absolute; top: 18%; left: 8%; width: 84%; font-size: 1.6vw; line-height: 1.6; white-space: pre-wrap; }\n  #scene-2-base .clip-body { width: 52%; }\n  .clip-image { position: absolute; top: 24%; right: 9%; width: 27%; height: auto; }\n  .subtitle { position:absolute;left:12%;right:12%;bottom:7%;z-index:10;padding:14px 22px;border-radius:10px;background:rgba(0,0,0,.72);text-align:center;font-size:1.6vw; }`;

  const scene1Div =
    `<div id="scene-1-base" class="clip" data-start="${(scene1Start / 1000).toFixed(4)}" data-duration="${(scene1.durationMs / 1000).toFixed(4)}" data-track-index="0" style="position:absolute;inset:0;background:#0f172a;opacity:1">` +
    `\n  <div dir="auto" class="clip-title">${escapeHtml(scene1.title)}</div>` +
    `\n  <div dir="auto" class="clip-body">${escapeHtml(scene1.body)}</div>` +
    `\n</div>`;

  const scene2Div =
    `<div id="scene-2-base" class="clip" data-start="${(scene2Start / 1000).toFixed(4)}" data-duration="${(scene2.durationMs / 1000).toFixed(4)}" data-track-index="0" style="position:absolute;inset:0;background:#1e293b;opacity:0;visibility:hidden">` +
    `\n  <div dir="auto" class="clip-title">${escapeHtml(scene2.title)}</div>` +
    `\n  <div dir="auto" class="clip-body">${escapeHtml(scene2.body)}</div>` +
    `\n  <img class="clip-image" src="${SAMPLE_IMAGE_ZIP_PATH}" alt="课程示意图" />` +
    `\n</div>`;

  const statements: string = [
    'var tl = gsap.timeline({ paused: true });',
    'tl.set("#scene-1-base", { autoAlpha: 1 }, 0);',
    'tl.set("#scene-2-base", { autoAlpha: 0 }, 0);',
    'tl.set("#subtitle-page-1", { display: "block" }, 0);',
    'tl.set("#subtitle-page-2", { display: "none" }, 0);',
    `tl.set("#scene-1-base", { autoAlpha: 0 }, ${(scene2Start / 1000).toFixed(4)});`,
    `tl.set("#scene-2-base", { autoAlpha: 1 }, ${(scene2Start / 1000).toFixed(4)});`,
    `tl.set("#subtitle-page-1", { display: "none" }, ${(scene2Start / 1000).toFixed(4)});`,
    `tl.set("#subtitle-page-2", { display: "block" }, ${(scene2Start / 1000).toFixed(4)});`,
    `tl.set({}, {}, ${totalSec}); /* composition length */`,
  ].join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(course.stageName)} \u2014 OpenMAIC video</title>
<style>
${style}
</style>
</head>
<body>
<div id="openmaic" data-composition-id="openmaic" data-start="0" data-duration="${totalSec}" data-width="${RENDER_W}" data-height="${RENDER_H}" style="position:relative;width:${RENDER_W}px;height:${RENDER_H}px;overflow:hidden;background:#000">
${scene1Div}
${scene2Div}
<audio id="course-tone" class="clip" data-start="0.0000" data-duration="${totalSec}" data-track-index="2" src="${SAMPLE_AUDIO_ZIP_PATH}" data-volume="0.18"></audio>
<div id="subtitle-page-1" class="subtitle" style="display:block">第一页：渲染管线总览。</div>
<div id="subtitle-page-2" class="subtitle" style="display:none">第二页：输出资料合同。</div>
</div>
<script src="assets/vendor/gsap.min.js"></script>
<script>
${statements}
window.__openmaicVideoManifest = { runtimeDiagnostics: [], manifestPath: "openmaic-video-manifest.json" };
window.__timelines = window.__timelines || {};
window.__timelines["openmaic"] = tl;
</script>
</body>
</html>
`;
}

function buildManifestJson(course: MiniCourse, totalDurationMs: number): string {
  const scene1 = course.pages[0];
  const scene2 = course.pages[1];
  const scene1Start = 0;
  const scene2Start = scene1.durationMs;

  const makeScene = (
    id: string,
    index: number,
    title: string,
    type: 'slide',
    startMs: number,
    durationMs: number,
  ) => ({
    id,
    index,
    title,
    type,
    startMs,
    durationMs,
    supported: true,
    base: { kind: 'placeholder', reason: '' },
    visuals: [],
    narration: [],
    effects: [],
    videos: [],
    markers: [],
  });

  const ir = {
    schema: VIDEO_TIMELINE_SCHEMA,
    version: VIDEO_TIMELINE_VERSION,
    compiler: VIDEO_TIMELINE_COMPILER,
    stage: { id: course.stageId, name: course.stageName },
    canvas: {
      viewBox: { width: CANVAS_VIEWBOX_W, height: CANVAS_VIEWBOX_H },
      pixelBase: { width: CANVAS_PIXEL_W, height: CANVAS_PIXEL_H },
      aspectRatio: CANVAS_ASPECT,
    },
    config: {
      playbackSpeed: 1,
      ttsEnabled: false,
      whiteboardInitiallyOpen: false,
    },
    totalDurationMs,
    scenes: [
      makeScene('scene-1', 0, scene1.title, 'slide', scene1Start, scene1.durationMs),
      makeScene('scene-2', 1, scene2.title, 'slide', scene2Start, scene2.durationMs),
    ],
    assets: { entries: [] },
    diagnostics: [],
  };

  return JSON.stringify(ir, null, 2) + '\n';
}

/** Compile a two-page Chinese text course into a render-service-acceptable ZIP. */
export async function compileTwoPageCourse(course: MiniCourse): Promise<Uint8Array> {
  if (course.pages.length !== 2) {
    throw new Error(`mini-compiler: expected exactly 2 pages, got ${course.pages.length}`);
  }
  for (const [i, p] of course.pages.entries()) {
    if (!Number.isInteger(p.durationMs) || p.durationMs <= 0) {
      throw new Error(`mini-compiler: page ${i + 1} durationMs must be a positive integer`);
    }
    if (typeof p.title !== 'string' || typeof p.body !== 'string') {
      throw new Error(`mini-compiler: page ${i + 1} title/body must be string`);
    }
  }

  const totalDurationMs = course.pages[0].durationMs + course.pages[1].durationMs;
  const gsapBytes = readFileSync(GSAP_PATH);

  const indexHtml = buildIndexHtml(course, totalDurationMs);
  const manifestJson = buildManifestJson(course, totalDurationMs);
  const subtitles = buildSubtitles(course);
  const zip = new JSZip();
  const date = new Date('1980-01-01T00:00:00Z');
  zip.file('index.html', indexHtml, { date });
  zip.file('openmaic-video-manifest.json', manifestJson, { date });
  zip.file('assets/vendor/gsap.min.js', gsapBytes, { date });
  zip.file(SAMPLE_IMAGE_ZIP_PATH, readFileSync(SAMPLE_IMAGE_PATH), { date });
  zip.file(SAMPLE_AUDIO_ZIP_PATH, createTwoPageToneWav(totalDurationMs, course.pages[0].durationMs), { date });
  zip.file('subtitles.srt', subtitles.srt, { date });
  zip.file('subtitles.vtt', subtitles.vtt, { date });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
