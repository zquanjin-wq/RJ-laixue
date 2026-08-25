/**
 * tests/video-mini-compiler/fixtures.ts — sanitized fixture for S3 V0.0.
 *
 * Two-page Chinese text course. No PII, no real course data. Public-domain
 * technical documentation text (lorem-ipsum-like) rephrased in Chinese.
 */

import type { MiniCourse } from '../../scripts/video-mini-compiler/compile.js';

export const twoPageSample: MiniCourse = {
  stageId: 'mini-stage-sample',
  stageName: 'Mini Compiler Sample',
  pages: [
    {
      title: '第一页 \u2014 渲染管线总览',
      body: [
        '\u6e32\u67d3\u670d\u52a1\u4ee5 Node.js + Chromium \u4e3a\u8fd0\u884c\u65f6\uff0c\u5728\u6d4f\u89c8\u5668\u4e2d\u52a0\u8f7d\u5e8f\u5217\u5408\u6210\u6587\u4ef6\uff0c\u4ee5 GSAP \u6682\u505c\u65f6\u95f4\u7ebf\u63a8\u8fdb\uff0c\u6309\u5e27\u622a\u56fe\u5e76\u5408\u6210 MP4\u3002',
        '\u672c\u7c7b\u578b\u7b80\u5316\u4e3a\u4e24\u9875\u6587\u672c\u8bfe\u4ef6\uff0c\u7528\u4e8e\u9a8c\u8bc1\u8f93\u51fa\u7684 ZIP \u7ed3\u6784\u3001\u5b57\u6bb5\u5b8c\u6574\u6027\u4e0e\u52a8\u753b\u95ed\u5305\u662f\u5426\u53ef\u9a8c\u8bc1\u3002',
      ].join('\n'),
      durationMs: 3000,
    },
    {
      title: '\u7b2c\u4e8c\u9875 \u2014 \u8f93\u51fa\u8d44\u6599\u5408\u540c',
      body: [
        '\u8f93\u51fa ZIP \u5305\u542b index.html\u3001\u5e8f\u5217\u5408\u6210 manifest \u4e0e\u8fd0\u884c\u65f6\u811a\u672c\uff0c\u4f9b\u6e32\u67d3\u670d\u52a1\u8bfb\u53d6\u3002',
        '\u5e8f\u5217\u5408\u6210\u4e2d GSAP \u4ee5\u5b50\u8bed\u8a00\u811a\u672c\u5185\u8054\uff0c\u4e0d\u4f9d\u8d56 CDN\uff0c\u786e\u4fdd\u5728\u4e0d\u5b58\u5728\u5916\u7f51\u8054\u901a\u7684\u73af\u5883\u4e0b\u4e5f\u53ef\u91cd\u653e\u3002',
      ].join('\n'),
      durationMs: 3000,
    },
  ],
};
