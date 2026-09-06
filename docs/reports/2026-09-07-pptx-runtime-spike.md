# PPTX 解析运行时验证（A2）

日期：2026-09-07；范围：本仓库 `@openmaic/importer` 的实际构建产物，不是生产容量压测。

## 结论

PPTX 的可编辑导入链路在浏览器 Chromium 中可用，纯 Node 进程不可用。因此，外部 PPT 生成课程不能把 importer 直接放进 Next/worker Node 进程；后续 C/F 批次应使用隔离 Chromium 执行器，并由任务 worker 调用它。当前文本生成 worker 不引入浏览器依赖。

## 实测样本

以 `pptxgenjs` 生成三份一页脱敏样本，通过预构建 `packages/@openmaic/importer/dist/index.js` 调用：

| 样本 | Chromium 结果 | 备注 |
| --- | --- | --- |
| 文本 + PNG | 1 页，shape、image，19 ms | 可编辑结构输出 |
| 表格 + 柱状图 | 1 页，shape、table、chart，9 ms | 表格、图表未降级为整页图片 |
| 讲师备注 | 1 页，shape，4 ms | `slide.script` 为“讲师原始备注：先提问，再解释。” |

纯 Node 运行同一 importer 在模块加载时失败：`XMLHttpRequest is not a constructor`。这与 importer 对浏览器 API / PDF 渲染依赖相符，不能通过在主服务中添加临时 polyfill 作为生产方案。

## 后续实现约束

- 原始 `.pptx` 先作为已确认课程资产保存；任务步骤记录输入 hash、解析器版本、导入结果和警告。
- Chromium 执行器采用受限请求、大小/解压条目/时限/内存上限，并禁止外部引用加载；这些是资源边界，不是对用户文件做攻防验证。
- 不支持的单个元素可降级并进入 warning；不得静默丢弃整页。解析失败保留原文件和可重试任务。
- 讲师备注优先写入每页 `script`，后续旁白/TTS 从备注生成并保留原始页面顺序。
- 在隔离执行器的镜像和真实样本视觉对照完成前，`inputKind=pptx` 不开放给外部调用。
