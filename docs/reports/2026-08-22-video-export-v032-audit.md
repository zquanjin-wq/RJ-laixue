# OpenMAIC v0.3.2 视频导出本地适配审计

- 日期：2026-08-22
- 分支：`chore/video-export-v032-audit`
- 基线：`test/r3-line` HEAD `4579519bfb66a19824584119bdceb45f916bbfe9`
- 上游基准：`v0.3.2`（commit `673af150`）
- 性质：只读审计，未修改产品代码、未部署、未建云资源

---

## 1. 本地现状

本地**没有**「课程导出为 MP4 视频」的能力。当前相关能力分三块，均与视频导出无直接关系：

| 能力 | 位置 | 说明 |
|---|---|---|
| AI 文生视频片段 | `lib/media/`（`media-orchestrator.ts`、`video-providers.ts`、`video-manifest.ts`）、`app/api/generate/video/route.ts` | 把 outline 里的 `mediaGenerations` 转成 `videoManifest`，调用视频 provider 生成**单个视频片段**，不是整课 MP4 |
| 课件导出 zip/html/pptx | `lib/export/`（`use-export-classroom.ts`、`use-export-pptx.ts`、`inline-assets.ts`、`proxied-fetch.ts`） | 纯客户端同步导出：从 Zustand `useStageStore` + IndexedDB（`db.stages`/`generatedAgents`/`audioFiles`/`mediaFiles`）收集数据，`jszip` 打包，`saveAs` 下载。无后台任务 |
| 后台 job（课程生成用） | `lib/server/classroom-job-runner.ts`、`classroom-job-store.ts` | 进程内 job（`Map` 存 runningJobs）+ Supabase job-store。用于 LLM 课程生成，**不能承载 Chromium/FFmpeg 渲染** |

本地缺失上游视频导出的全部目录：`lib/video-export/`、`lib/video-export-app/`、`render-service/`、`app/api/export-video/` 均不存在。

本地已具备的可复用基础（对移植有利）：
- `@openmaic/dsl`（Stage/Scene/SceneContent/Action 契约，与上游同源）
- `@openmaic/renderer`（含 `snapshot/slideToPng`，`packages/@openmaic/renderer/src/snapshot/index.ts:79`）
- 安全设施：`lib/server/api-guard.ts`（`requireAuthOrTeacher`）、`lib/server/course-access.ts`（`checkCourseReadAccess`）、`lib/server/ssrf-guard.ts`、`lib/server/proxy-fetch.ts`

## 2. 上游实现

上游 v0.3.2 有完整的视频导出，架构是「浏览器编译 + 独立渲染服务」：

**数据流**（教师点击导出 → 下载 MP4）：

1. `components/stage/video-export-dialog.tsx` 导出对话框，两条路径：
   - **Render MP4**（`RENDER_SERVICE_URL` 配置时）：上传 ZIP、轮询 job、下载 MP4
   - **Download ZIP**（始终可用的降级路径）：浏览器 `buildExportZip` → `saveAs` 本地 CLI 渲染
2. `lib/video-export-app/collect.ts`：从 **Dexie 记录**读 narration/media，用 `@openmaic/renderer/snapshot` 的 `slideToPng` 渲染幻灯片基帧，经 `lib/media/*` 解析生成媒体的可渲染 URL（`use-asset-url`、`resolve-media-ref`、`media-task-resolution`、`slide-media-slots`）
3. `lib/video-export/`：**纯编译器**（`compile.ts` → `ir.ts` 中间表示），多 pass（`passes/normalize`、`timeline`、`visuals`、`emit`、`assets`、`geometry`、`reflow`、`probe`、`interactive`），产出 Hyperframes 项目 ZIP（`index.html` + `assets/` + vendored GSAP）
4. `lib/video-export-app/use-render-video.ts`：上传 ZIP → `app/api/export-video/render/route.ts` 流式转发给 render-service → 轮询 `[jobId]` → 下载
5. `render-service/`：独立 Node 22 容器，用 `@hyperframes/producer@0.7.60` 驱动 **headless Chromium（帧捕获）+ FFmpeg（编码）** 合成 MP4

**渲染引擎**：`render-service/package.json` 依赖 `@hyperframes/producer@0.7.60`（第三方库）、`hono`（HTTP）、`fflate`（解压）。README 明确「producer needs Node ≥ 22, Chromium, and FFmpeg — none of which belong in the Next.js runtime」。

**能力覆盖**（`lib/video-export/emit-hyperframes/`）：
- KaTeX 公式：`katex-assets.ts` 内嵌完整 KaTeX 0.16.38 CSS + 20 个 WOFF2 字体（生成文件，`pnpm gen:video-export-katex` 重新生成）
- 中文字体：`noto-cjk-assets.ts`（Noto CJK）
- 英文字体：`inter-font.ts`（Inter，SIL OFL 许可）
- 聚光/激光：`effects.ts` 把 IR 的 `spotlight.v1`/`laser.v1` 转成 overlay HTML + GSAP 确定性 tween（无 wall-clock、无随机、无无限循环）
- Quiz/PBL 封面：`passes/visuals.ts`（`quizCover`/`pblCover`）
- 视频片段：`passes/timeline.ts` 处理 `play_video` action → `VideoSegment`，带时长解析上限 `MAX_VIDEO_WAIT_MS`
- 字幕：burn-in（可选，默认关）或下载 SRT（`use-download-subtitles.ts`）

**任务生命周期**（`render-service/README.md`）：
- `POST /render` → `202 { jobId }`；`GET /render/:jobId` 轮询 status/progress；`GET /render/:jobId/download` 流式 MP4；`DELETE /render/:jobId` 取消
- status: `queued | running | succeeded | failed | cancelled`；job TTL 30min，deadline 45min
- 支持 presigned URL 产物存储（`artifact-store.ts`），OSS 默认本地磁盘

## 3. 可以直接借鉴什么

以下部分**低冲突，可直接借鉴**：

1. **`lib/video-export/` 纯编译器**：依赖 `@openmaic/dsl`（本地已有，同源）。编译逻辑与本地数据模型解耦，是纯函数，移植风险最低。
2. **`render-service/` 整套服务**：上游已把渲染服务做成**独立、opt-in、无状态**（`RENDER_SERVICE_URL` 未配置时降级为 ZIP 下载）。这份服务与主 app 通过 HTTP 解耦，几乎可以原样部署（只需配 `RENDER_SERVICE_URL`）。
3. **`emit-hyperframes/` 的字体/公式/效果发射**：KaTeX、Noto CJK、Inter、聚光/激光的确定性发射是生成文件 + 纯函数，可直接复用。
4. **安全基线**：`render-service` 的 ZIP 解压 bounds（防 zip bomb）、egress lockdown、上传大小限制，是成熟的防御设计，直接沿用。

## 4. 哪些必须按本地架构改写

以下部分**冲突或缺失，必须改写/补写**：

1. **`collect.ts` 的媒体解析层（最大冲突点）**：上游 `collect.ts` 依赖 `lib/media/use-asset-url`、`lib/media/resolve-media-ref`、`lib/media/media-task-resolution`、`lib/media/slide-media-slots`、`lib/store/media-generation`。本地 `lib/media/` 结构不同（只有 `media-orchestrator`、`video-providers`、`image-providers`、`video-manifest`、`types`），且 `use-asset-url`/`resolve-media-ref`/`media-task-resolution`/`slide-media-slots` **本地不存在**。必须按本地 media 层重写「mediaRef → 可渲染 blob/URL」的解析，复用本地已有的 `media-orchestrator` 语义。
2. **鉴权（本地必须补）**：上游 `app/api/export-video/render/route.ts` 和 `download/route.ts` **无显式 auth 校验**（上游默认单用户自部署，仅靠 `clientIdentity` 做可选 per-user 限流）。本地是 admin/teacher/learner 三级 + RLS，必须加 `requireAuthOrTeacher` + `checkCourseReadAccess`，并让 download 链路校验 jobId ↔ 当前用户课程的绑定关系。
3. **`lib/server/capped-stream.ts`**：上游 render route 依赖 `capBodyStream`（流式限字节上传），本地 `lib/server/` 无此文件，需补。
4. **`lib/server/render-service.ts` 客户端**：本地有 `proxy-fetch.ts`，但需确认 SSRF guard 与 `RENDER_SERVICE_URL`（内部服务地址）的交互——上游明确该 URL 不走 SSRF guard（`lib/server/render-service.ts` 注释），本地需评估此豁免是否可接受。

## 5. 是否需要独立 render-service

**需要，且是硬前提。**

`render-service` 需要 Node ≥ 22 + Chromium headless shell + FFmpeg + 4–10 GiB 内存 + `CAP_NET_ADMIN`（egress lockdown），渲染一个 10 分钟视频可耗时数十分钟。**Vercel serverless 无法承载**：
- 函数 `maxDuration` 300s（本地 `vercel.json` 已设 300s），远低于渲染时长；
- 无 Chromium/FFmpeg 运行时、无持久磁盘（`/tmp` 之外的产物无法保存）、内存受限。

因此 render-service 必须独立部署（云 VM / 容器服务 / 自建服务器），主 app 通过 `RENDER_SERVICE_URL` 调用。这是本任务唯一的**外部资源**，也是最主要的工程前置项。

## 6. 推荐的 V0 范围

**包含**：
- 教师导出自己的课程（`requireAuthOrTeacher` + `checkCourseReadAccess` 校验）
- 输出 MP4
- 页面关闭后任务继续（job 持久化在 render-service，主 app 轮询）
- 完成后可回来下载（jobId 查询 + 下载）
- 文本、图片、音频、字幕、中文字体（Noto CJK）、KaTeX 公式、聚光指示

**暂不做**（与任务卡一致）：在线剪辑、多清晰度、学生导出、永久公开分享、自定义片头/水印、多语言重配音。

**明确推迟**：视频片段的真实播放渲染。上游虽支持 `play_video`（`passes/timeline.ts`），但依赖视频时长解析、首帧 poster 解码等复杂链路，且本地视频片段走 `lib/media/` 与上游不同。V0 采用「视频片段显示首帧/封面」，不渲染真实视频帧——与上游 Quiz/PBL 封面策略一致，风险可控。

## 7. 分成哪几步实施

1. **P0：独立部署 render-service**（几乎原样复用上游 `render-service/`，配 `RENDER_SERVICE_URL`，跑通 `/health`）。这是 GO 的硬前提。
2. **P1：移植 `lib/video-export/` 纯编译器 + `emit-hyperframes/`**（低冲突，依赖本地已有 `@openmaic/dsl`），补 `gen:video-export-katex` 生成脚本。
3. **P2：按本地 media 层改写 `collect.ts`**（最高工作量/风险点），复用本地 `media-orchestrator` + `@openmaic/renderer/snapshot/slideToPng`，产出与上游同构的资产 plan。
4. **P3：移植 `app/api/export-video/*` + 补鉴权 + 补 `capped-stream`**，接入 `requireAuthOrTeacher`/`checkCourseReadAccess`。
5. **P4：前端导出对话框 + 入口**（`video-export-dialog.tsx` + `use-render-video.ts` + 下载 ZIP 降级路径），接本地 i18n。

主要难点集中在 P2（媒体解析改写）和 P0（外部服务部署），其余是可预期的移植工作。

## 8. 是否建议现在开工

建议**有条件开工**。上游实现的完整度和可移植性都较高：纯编译器与渲染服务与本地架构解耦，可复用；但存在两个必须先解决的前置项（独立 render-service 部署、鉴权方案确认）和一个高工作量改写点（collect 媒体解析）。在 render-service 部署条件未落实前，不应进入本地渲染验证。

---

## 结论

**GO WITH CONDITIONS** —— 满足以下前提后进入本地渲染验证：

1. **独立 render-service 已部署且 `/health` 可达**（Node 22 + Chromium headless shell + FFmpeg 容器，4–10 GiB 内存，egress lockdown 策略明确）；
2. **鉴权方案已确认**：视频导出的 render/download 链路补齐 `requireAuthOrTeacher` + `checkCourseReadAccess`，并建立 jobId ↔ 课程/用户的绑定校验（上游无鉴权，本地多用户场景不可直接沿用）；
3. **collect 媒体解析改写的范围已评估**：确认本地 `lib/media/` 与上游媒体解析管线的差异可控，或接受 V0 先以「视频片段显示首帧」缩小改写面。

未满足前两条时，结论退化为 **NO-GO（暂缓）**——不应在没有渲染服务与鉴权的情况下启动本地渲染验证。

---

### 附：安全风险清单（审计发现，供后续设计卡引用）

| 风险 | 上游现状 | 本地必须处理 |
|---|---|---|
| 课程权限 | render/download route 无 auth | 加 `requireAuthOrTeacher` + `checkCourseReadAccess` |
| 私有资源访问 | 课件打包成自包含 ZIP，媒体在浏览器端内联/解析后打包，render-service 不直接访问课程资源（egress lockdown 兜底） | 确认本地媒体 blob 打包路径无外泄 |
| 任意 URL / SSRF | render-service egress lockdown（iptables）防 SSRF；`RENDER_SERVICE_URL` 明确不走 SSRF guard（内部服务地址） | 评估 `RENDER_SERVICE_URL` 豁免是否可接受，保留其余 SSRF guard |
| 下载链接 | download route 直接按 jobId 下载，无 auth | jobId 加用户绑定校验，下载链接私有化 |
| 上传炸弹 | render-service 解压 bounds（entry 数/大小/压缩比） | 沿用 |

### 附：证据文件索引

- 本地导出现状：`lib/export/use-export-classroom.ts:43-242`（zip 导出全流程）、`lib/media/video-manifest.ts:9-24`（文生视频 manifest）
- 上游渲染服务：`render-service/package.json`（`@hyperframes/producer@0.7.60`）、`render-service/README.md`（环境变量、资源画像、安全隔离、HTTP API）
- 上游编译/收集：`lib/video-export-app/collect.ts`（Dexie 记录 + `slideToPng` + media 解析）、`lib/video-export/emit-hyperframes/`（字体/公式/效果）
- 上游鉴权缺口：`app/api/export-video/render/route.ts`（POST 无 auth）、`render/[jobId]/download/route.ts`（GET 无 auth）
- 本地安全设施：`lib/server/api-guard.ts:60`、`lib/server/course-access.ts:22`、`lib/server/ssrf-guard.ts`、`lib/server/proxy-fetch.ts`
