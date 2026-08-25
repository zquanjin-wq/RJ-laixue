# 视频导出 S3.1：两页文本课件编译

- 日期：2026-08-26
- 分支：`chore/video-export-mini-compiler`
- 基线：`55013842`
- 状态：PASSED

## 完成内容

- 新增固定、脱敏的两页中文文本课件 fixture。
- 新增最小编译器，输出 render-service 可读取的 ZIP。
- ZIP 仅包含 `index.html`、`openmaic-video-manifest.json` 和本地 GSAP。
- GSAP 时间线在第 3 秒切换两页的可见状态。
- 未接入图片、音频、公式、聚光、Quiz/PBL、API、UI 或部署。

## 验证

专项测试 `tests/video-mini-compiler/zip-contract.test.ts`：5/5 通过。

覆盖：

- ZIP 必要文件
- 两页中文内容
- 两场景 manifest 与时间
- 第二页开始时的显隐切换

`git diff --check` 通过。

## 实现取舍

- 复用项目已有的 JSZip，不维护自制 ZIP writer。
- 不增加哈希、容量上限或低概率异常测试。
- 本阶段只证明文本课件可以编译为渲染输入，不生成 MP4。

## 下一步

S3.2 只验证本 ZIP 经已签字的 render-service 生成 MP4，并核对两页切换与中文显示。其他媒体能力继续推迟。
