/**
 * tests/video-mini-compiler/zip-contract.test.ts — S3 V0.0 契约测试。
 *
 * 不启动 render-service，不读 git artifacts；只对编译器输出的 ZIP 做结构验证。
 * 覆盖范围（任务卡要求）：
 *   - 必要文件齐全
 *   - index.html 关键结构（<div class="clip"> x2, GSAP, __timelines）
 *   - 中文文本覆盖
 *   - 时间线 2 页（两条 scene）
 *   - 时间线在第二页开始时切换可见场景
 *
 * 出错即失败（exit 1）。
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { compileTwoPageCourse } from '../../scripts/video-mini-compiler/compile.js';
import { writeTwoPageFixtureZip } from '../../scripts/video-mini-compiler/write-fixture.js';
import { twoPageSample } from './fixtures.js';

async function unzip(bytes: Uint8Array): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(bytes);
  const entries: Record<string, string> = {};
  await Promise.all(
    Object.entries(zip.files).map(async ([path, file]) => {
      if (!file.dir) entries[path] = await file.async('string');
    }),
  );
  return entries;
}

async function readZipBytes(bytes: Uint8Array, path: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file(path);
  if (!file) throw new Error(`missing ZIP entry: ${path}`);
  return file.async('uint8array');
}

const REQUIRED_PATHS = [
  'index.html',
  'openmaic-video-manifest.json',
  'assets/vendor/gsap.min.js',
  'assets/images/mini-course-illustration.svg',
  'assets/audio/two-page-tone.wav',
  'assets/vendor/katex/katex.min.css',
  'subtitles.srt',
  'subtitles.vtt',
];

describe('mini-compiler ZIP contract (S3 V0.0)', () => {
  it('emits all required paths', async () => {
    const entries = await unzip(await compileTwoPageCourse(twoPageSample));
    const paths = Object.keys(entries).sort();
    for (const path of REQUIRED_PATHS) expect(paths).toContain(path);
  });

  it('index.html contains two class="clip" divs and a paused GSAP timeline', async () => {
    const html = (await unzip(await compileTwoPageCourse(twoPageSample)))['index.html'];

    expect(html).toContain('id="openmaic"');
    expect(html).toContain('data-duration="6.0000"'); // 3s + 3s
    expect(html).toContain('window.__timelines["openmaic"]');
    expect(html).toContain('gsap.timeline({ paused: true })');
    expect(html).toContain('class="clip"');
    expect((html.match(/<div id="scene-[12]-base" class="clip"/g) || []).length).toBe(2);
    expect(html).toContain('id="scene-2-base"');
    expect(html).toContain('opacity:0;visibility:hidden');
    expect(html).toContain('assets/vendor/gsap.min.js');
    expect(html).toContain('src="assets/images/mini-course-illustration.svg"');
    expect(html).toContain('id="course-tone"');
    expect(html).toContain('data-track-index="2"');
    expect(html).toContain('src="assets/audio/two-page-tone.wav"');
    expect(html).toContain('window.__openmaicVideoManifest');
    // Chinese text pass-through (one of the fixture sentences).
    expect(html).toContain('Node.js + Chromium');
  });

  it('writes a two-scene manifest', async () => {
    const entries = await unzip(await compileTwoPageCourse(twoPageSample));

    const manifest = JSON.parse(entries['openmaic-video-manifest.json']);
    expect(manifest.schema).toBe('openmaic.videoTimeline');
    expect(manifest.version).toBe(4);
    expect(manifest.totalDurationMs).toBe(6000);
    expect(manifest.scenes.length).toBe(2);
    expect(manifest.scenes[0].startMs).toBe(0);
    expect(manifest.scenes[0].durationMs).toBe(3000);
    expect(manifest.scenes[1].startMs).toBe(3000);
    expect(manifest.scenes[1].durationMs).toBe(3000);
  });

  it('covers Chinese text in both pages', async () => {
    const html = (await unzip(await compileTwoPageCourse(twoPageSample)))['index.html'];
    // 渲染服务总览 + 渲染资料合同 + GSAP
    expect(html).toMatch(/渲染服务|渲染管线/);
    expect(html).toMatch(/输出 ZIP/);
    expect(html).toMatch(/GSAP/);
  });

  it('includes an offline KaTeX formula instead of formula source text', async () => {
    const bytes = await compileTwoPageCourse(twoPageSample);
    const entries = await unzip(bytes);
    const zip = await JSZip.loadAsync(bytes);
    const html = entries['index.html'];

    expect(html).toContain('assets/vendor/katex/katex.min.css');
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="mfrac"');
    expect(html).not.toContain('\\frac{6}{2}');

    const css = entries['assets/vendor/katex/katex.min.css'];
    expect(css).toContain('KaTeX_Main');
    expect(Object.keys(zip.files).some((path) => path.startsWith('assets/vendor/katex/fonts/') && path.endsWith('.woff2'))).toBe(true);
  });

  it('switches scene visibility at the second page start', async () => {
    const html = (await unzip(await compileTwoPageCourse(twoPageSample)))['index.html'];

    expect(html).toContain('tl.set("#scene-1-base", { autoAlpha: 1 }, 0);');
    expect(html).toContain('tl.set("#scene-2-base", { autoAlpha: 0 }, 0);');
    expect(html).toContain('tl.set("#scene-1-base", { autoAlpha: 0 }, 3.0000);');
    expect(html).toContain('tl.set("#scene-2-base", { autoAlpha: 1 }, 3.0000);');
    expect(html).toContain('tl.set("#subtitle-page-1", { display: "none" }, 3.0000);');
    expect(html).toContain('tl.set("#subtitle-page-2", { display: "block" }, 3.0000);');
  });

  it('includes a self-generated WAV narration track', async () => {
    const audio = await readZipBytes(
      await compileTwoPageCourse(twoPageSample),
      'assets/audio/two-page-tone.wav',
    );
    expect(String.fromCharCode(...audio.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...audio.slice(8, 12))).toBe('WAVE');
    expect(audio.byteLength).toBeGreaterThan(90000);
  });

  it('writes two three-second subtitle cues as SRT and VTT', async () => {
    const entries = await unzip(await compileTwoPageCourse(twoPageSample));
    expect(entries['subtitles.srt']).toContain('00:00:00,000 --> 00:00:03,000');
    expect(entries['subtitles.srt']).toContain('00:00:03,000 --> 00:00:06,000');
    expect(entries['subtitles.srt']).toContain('第一页：渲染管线总览。');
    expect(entries['subtitles.srt']).toContain('第二页：输出资料合同。');
    expect(entries['subtitles.vtt']).toContain('WEBVTT');
    expect(entries['subtitles.vtt']).toContain('00:00:03.000 --> 00:00:06.000');
  });

  it('writes the fixed fixture ZIP for the render runner', async () => {
    const outputPath = join(mkdtempSync(join(tmpdir(), 'video-mini-')), 'fixture.zip');
    await writeTwoPageFixtureZip(outputPath);
    const entries = await unzip(readFileSync(outputPath));
    expect(entries['index.html']).toContain('第二页 — 输出资料合同');
    expect(entries['assets/images/mini-course-illustration.svg']).toContain('课程渲染流程示意图');
    expect(entries['subtitles.srt']).toContain('第二页：输出资料合同。');
  });
});
