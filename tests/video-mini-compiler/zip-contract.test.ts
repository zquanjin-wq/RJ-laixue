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
import JSZip from 'jszip';
import { compileTwoPageCourse } from '../../scripts/video-mini-compiler/compile.js';
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

const REQUIRED_PATHS = [
  'index.html',
  'openmaic-video-manifest.json',
  'assets/vendor/gsap.min.js',
];

describe('mini-compiler ZIP contract (S3 V0.0)', () => {
  it('emits all required paths', async () => {
    const entries = await unzip(await compileTwoPageCourse(twoPageSample));
    const paths = Object.keys(entries).sort();
    expect(paths.sort()).toEqual([...REQUIRED_PATHS].sort());
  });

  it('index.html contains two class="clip" divs and a paused GSAP timeline', async () => {
    const html = (await unzip(await compileTwoPageCourse(twoPageSample)))['index.html'];

    expect(html).toContain('id="openmaic"');
    expect(html).toContain('data-duration="6.0000"'); // 3s + 3s
    expect(html).toContain('window.__timelines["openmaic"]');
    expect(html).toContain('gsap.timeline({ paused: true })');
    expect(html).toContain('class="clip"');
    expect((html.match(/class="clip"/g) || []).length).toBe(2);
    expect(html).toContain('id="scene-2-base"');
    expect(html).toContain('opacity:0;visibility:hidden');
    expect(html).toContain('assets/vendor/gsap.min.js');
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

  it('switches scene visibility at the second page start', async () => {
    const html = (await unzip(await compileTwoPageCourse(twoPageSample)))['index.html'];

    expect(html).toContain('tl.set("#scene-1-base", { autoAlpha: 1 }, 0);');
    expect(html).toContain('tl.set("#scene-2-base", { autoAlpha: 0 }, 0);');
    expect(html).toContain('tl.set("#scene-1-base", { autoAlpha: 0 }, 3.0000);');
    expect(html).toContain('tl.set("#scene-2-base", { autoAlpha: 1 }, 3.0000);');
  });
});
