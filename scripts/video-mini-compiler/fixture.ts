/** Fixed, non-business two-page course used by the S3 compiler proof. */

import type { MiniCourse } from './compile.js';

export const twoPageSample: MiniCourse = {
  stageId: 'mini-stage-sample',
  stageName: 'Mini Compiler Sample',
  pages: [
    {
      title: '第一页 — 渲染管线总览',
      body: [
        '渲染服务以 Node.js + Chromium 为运行时，在浏览器中加载序列合成文件，以 GSAP 暂停时间线推进，按帧截图并合成 MP4。',
        '本课件简化为两页文本，用于验证输出的 ZIP 结构、字段完整性与动画闭包是否可验证。',
      ].join('\n'),
      durationMs: 3000,
    },
    {
      title: '第二页 — 输出资料合同',
      body: [
        '输出 ZIP 包含 index.html、序列合成 manifest 与运行时脚本，供渲染服务读取。',
        '序列合成中 GSAP 以内联脚本运行，不依赖 CDN，确保在没有外网的环境下也可重放。',
      ].join('\n'),
      durationMs: 3000,
    },
  ],
};
