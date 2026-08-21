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

1. **`render-service/` 整套服务（最低冲突）**：上游已把渲染服务做成**独立、opt-in、自包含**（`RENDER_SERVICE_URL` 未配置时降级为 ZIP 下载）。与主 app 通过 HTTP 解耦，本身可整体复制部署（Node 22 + Chromium headless shell + FFmpeg 容器），无需改动主 app。
2. **`emit-hyperframes/` 的字体/公式发射（生成文件）**：KaTeX 0.16.38（`katex-assets.ts`，20 个 WOFF2）、Noto CJK（`noto-cjk-assets.ts`）、Inter（`inter-font.ts`）是生成文件 + 纯函数，可直接复用。
3. **`render-service` 的安全基线**：ZIP 解压五重 bounds（entry 数/单条大小/总展开/压缩比/路径穿越，`unzip.ts`）、egress lockdown（`docker-entrypoint.sh` iptables）、上传大小限制，是成熟防御，直接沿用。
4. **`lib/video-export/` 编译器 + 效果发射（中等冲突，见 §4）**：编译逻辑本身是纯函数，但**依赖本地缺失的 `lib/choreography/`**（聚光/激光 descriptor 与 `resolveActionTimeline` 都在这里），需一起移植。不能只复制 `lib/video-export/` 单目录。

## 4. 哪些必须按本地架构改写

以下部分**冲突或缺失，必须改写/补写**（逐条经上游文件 import 反查确认）：

1. **`collect.ts` / `timeline-deps.ts` 的媒体解析层（最大改写点）**：上游依赖本地缺失的 `lib/media/` 7+ 文件——`resolve-media-ref.ts`、`media-task-resolution.ts`、`slide-media-slots.ts`、`resolve-audio-bytes.ts`、`use-asset-url.ts`、`polled-task.ts`、`media-ref.ts`。本地 `lib/media/` 结构不同（`media-orchestrator`/`video-providers`/`image-providers`/`video-manifest`），必须按本地 media 层重写「mediaRef → 可渲染 blob/URL」解析。
2. **`lib/choreography/` 整个目录缺失**：上游 `passes/timeline.ts` 与 `emit-hyperframes/effects.ts` 依赖它（`resolveActionTimeline`、`spotlight.v1`/`laser.v1` descriptor）。缺它编译器无法工作，必须一起移植。
3. **`@openmaic/renderer/src/snapshot/` 漂移**：上游有 `measure.ts` + `katex-fonts-embed.ts`，本地只有 `slideToPng`（`snapshot/index.ts`）；且本地 `slideToPng` 是纯 html2canvas-pro 版，上游是 html2canvas-pro + native paint 回退版。`timeline-deps.ts` 依赖 `measureSlideElementGeometry`，本地缺失。
4. **DSL 契约漂移**：本地 `@openmaic/dsl` 的 `SceneContent = SlideContent | QuizContent`（二元组）；上游把 `InteractiveContent`/`PBLContent` 下沉进 dsl 契约（四元组）。本地 `lib/types/stage.ts` 自己在 app 层定义 interactive/pbl。编译器若按四元组读写 SceneContent，需适配。
5. **`lib/document-store/` 缺失**：上游 `build-export-zip.ts` 用 `accessDocument(stage.id)` 拿 stage 名；本地只有 `lib/document-bridge/`（无 `accessDocument`），需适配或改从本地 stage store 直接读名。
6. **`lib/store/video-render.ts` 缺失**：上游渲染生命周期（全局 zustand store，progress 跨菜单存活）本地无，需新写。
7. **鉴权（本地必须补）**：上游 `app/api/export-video/**` 四个 route 无 per-user/per-course 鉴权，仅靠 `middleware.ts` 的 HMAC `openmaic_access` cookie（部署级共享口令，`ACCESS_CODE` 未设则放行）。本地是 admin/teacher/learner 三级 + RLS，必须加 `requireAuthOrTeacher` + `checkCourseReadAccess` + jobId↔用户绑定。
8. **`lib/server/capped-stream.ts` 缺失**：上游 render route 依赖 `capBodyStream`（流式限字节上传），本地需补。

## 5. 是否需要独立 render-service

**需要，且是硬前提。**

`render-service` 需要 Node ≥ 22 + Chromium headless shell + FFmpeg + 4–10 GiB 内存 + `CAP_NET_ADMIN`（egress lockdown），渲染一个 10 分钟视频可耗时数十分钟。**Vercel serverless 无法承载**：
- 函数 `maxDuration` 300s（本地 `vercel.json` 已设 300s），远低于渲染时长；
- 无 Chromium/FFmpeg 运行时、无持久磁盘（`/tmp` 之外的产物无法保存）、内存受限。

因此 render-service 必须独立部署（云 VM / 容器服务 / 自建服务器），主 app 通过 `RENDER_SERVICE_URL` 调用。这是本任务唯一的**外部资源**，也是最主要的工程前置项。

**部署细节（影响 V0 目标，需注意）**：
- 默认 `InMemoryJobStore`（进程内存 Map）+ `LocalDiskArtifactStore`（MP4 留 `/tmp/openmaic-renders` 本地磁盘，**不是 S3**），产物 TTL 30 分钟。S3/Redis 是上游标注的后续 swap 点，尚未实现。
- **jobId 不持久化**：`jobId` 是 `randomUUID()`，只存浏览器内存的 `lib/store/video-render.ts`（全局 zustand store，跨菜单存活），**无 localStorage/IndexedDB 持久化**，render-service **无 job 列表接口**。因此「关闭页面/刷新后恢复下载」在上游是**不支持的**——服务端渲染继续，但客户端拿不回 jobId（只能等 TTL 过期）。

## 6. 推荐的 V0 范围

**包含**：
- 教师导出自己的课程（`requireAuthOrTeacher` + `checkCourseReadAccess` 校验）
- 输出 MP4
- 文本、图片、音频、字幕、中文字体（Noto CJK）、KaTeX 公式、聚光指示

**V0 目标「页面关闭后继续、完成后回来下载」是本地必须补写的能力**（上游不支持）：
- 「关闭导出菜单/切场景」上游已支持（`video-render.ts` 全局 store）；
- 「关闭页面/刷新后回来下载」**上游不支持**（jobId 不持久化、无 job 列表接口）。本地 V0 需补：jobId 落 Supabase（或 localStorage）+ 「我的导出任务」列表 + 完成后下载入口。这是本地相对上游的**净新增**，工作量需计入。

**暂不做**（与任务卡一致）：在线剪辑、多清晰度、学生导出、永久公开分享、自定义片头/水印、多语言重配音。

**明确推迟**：视频片段的真实播放渲染。上游虽支持 `play_video`（`passes/timeline.ts`），但依赖视频时长解析、首帧 poster 解码等复杂链路，且本地视频片段走 `lib/media/` 与上游不同。V0 采用「视频片段显示首帧/封面」，不渲染真实视频帧——与上游 Quiz/PBL 封面策略一致，风险可控。

## 7. 分成哪几步实施

1. **P0：独立部署 render-service**（几乎原样复用上游 `render-service/`，配 `RENDER_SERVICE_URL`，跑通 `/health`）。这是 GO 的硬前提。
2. **P1：移植编译链 + 效果发射**：`lib/video-export/` + `emit-hyperframes/` + **`lib/choreography/`**（前者硬依赖后者），补 `gen:video-export-katex` 生成脚本，适配 dsl `SceneContent` 二元组→四元组漂移。
3. **P2：按本地 media 层改写 `collect.ts` + `timeline-deps.ts`**（最高工作量/风险点）：补齐/适配缺失的 7+ 个 `lib/media/*`、`renderer/snapshot` 的 `measure.ts`，复用本地 `media-orchestrator` + `slideToPng`。
4. **P3：补写「关页恢复」**：jobId 落 Supabase + 「我的导出任务」列表 + 完成下载入口（上游无此能力，本地净新增）。
5. **P4：移植 `app/api/export-video/*` + 补鉴权 + 补 `capped-stream`**，接入 `requireAuthOrTeacher`/`checkCourseReadAccess` + jobId↔用户绑定。
6. **P5：前端导出对话框 + 入口**（`video-export-dialog.tsx` + `use-render-video.ts` + `lib/store/video-render.ts` + 下载 ZIP 降级路径），接本地 i18n。

主要难点集中在 P2（媒体解析改写）、P3（关页恢复净新增）、P0（外部服务部署）。整体移植风险为**中等偏高**：上游缺失依赖的本地闭包较大，不能只复制 `lib/video-export/` 单目录。

## 8. 是否建议现在开工

建议**有条件开工**。上游实现的完整度和可移植性都较高：纯编译器与渲染服务与本地架构解耦，可复用；但存在两个必须先解决的前置项（独立 render-service 部署、鉴权方案确认）和一个高工作量改写点（collect 媒体解析）。在 render-service 部署条件未落实前，不应进入本地渲染验证。

---

## 结论

**GO WITH CONDITIONS** —— 满足以下前提后进入本地渲染验证：

1. **独立 render-service 已部署且 `/health` 可达**（Node 22 + Chromium headless shell + FFmpeg 容器，4–10 GiB 内存，egress lockdown 策略明确）；
2. **鉴权方案已确认**：视频导出的 render/download 链路补齐 `requireAuthOrTeacher` + `checkCourseReadAccess`，并建立 jobId ↔ 课程/用户的绑定校验（上游无 per-user 鉴权，本地多用户场景不可直接沿用）；
3. **缺失依赖移植范围已评估**：确认 `lib/choreography`、`lib/media/` 7+ 文件、`renderer/snapshot/measure.ts`、`lib/store/video-render.ts`、`lib/document-store`（本地为 `document-bridge`）的本地依赖闭包可控；
4. **「关页恢复」能力已纳入 V0 范围**：上游 jobId 不持久化，本地需补写 jobId 落库 + 任务列表，这是净新增，需单独评估工作量。

未满足前两条时，结论退化为 **NO-GO（暂缓）**——不应在没有渲染服务与鉴权的情况下启动本地渲染验证。整体移植风险为**中等偏高**（非低风险），不能只复制 `lib/video-export/` 单目录。

---

### 附：安全风险清单（审计发现，供后续设计卡引用）

| 风险 | 上游现状 | 本地必须处理 |
|---|---|---|
| 课程权限 | render/download route 无 per-user/per-course auth；仅 `middleware.ts` HMAC `openmaic_access` cookie（部署级共享口令，`ACCESS_CODE` 未设则放行） | 加 `requireAuthOrTeacher` + `checkCourseReadAccess` |
| 私有资源访问 | 课件打包成自包含 ZIP，媒体在浏览器端内联/解析后打包，render-service 不直接访问课程资源（egress lockdown 兜底，渲染零出站） | 确认本地媒体 blob 打包路径无外泄 |
| 任意 URL / SSRF | render-service egress lockdown（iptables）防 SSRF；`RENDER_SERVICE_URL` 明确不走 SSRF guard（内部服务地址） | 评估 `RENDER_SERVICE_URL` 豁免是否可接受，保留其余 SSRF guard |
| 下载链接 | download route 直接按 jobId 下载，无 auth，jobId 无 per-user 绑定 | jobId 加用户绑定校验，下载链接私有化 |
| 上传炸弹 | render-service 解压五重 bounds（entry 数/单条大小/总展开/压缩比/路径穿越） | 沿用 |

### 附：证据文件索引

- 本地导出现状：`lib/export/use-export-classroom.ts:43-242`（zip 导出全流程）、`lib/media/video-manifest.ts:9-24`（文生视频 manifest）
- 上游渲染服务：`render-service/package.json`（`@hyperframes/producer@0.7.60`）、`render-service/README.md`（环境变量、资源画像、安全隔离、HTTP API）、`render-service/Dockerfile`（chromium-headless-shell + ffmpeg）
- 上游编译/收集：`lib/video-export-app/collect.ts`（Dexie 记录 + `slideToPng` + media 解析）、`lib/video-export/emit-hyperframes/`（字体/公式/效果）、`lib/video-export/passes/timeline.ts`（依赖 `lib/choreography`）
- 上游渲染执行：`render-service/src/render-executor.ts:164-212`（`InProcessExecutor.execute` 调 `@hyperframes/producer`）
- 上游任务生命周期：`render-service/src/job-store.ts`（InMemoryJobStore）、`render-service/src/artifact-store.ts`（LocalDiskArtifactStore）、`lib/store/video-render.ts`（jobId 仅内存）
- 上游鉴权缺口：`app/api/export-video/render/route.ts`（POST 无 auth）、`render/[jobId]/download/route.ts`（GET 无 auth）、`middleware.ts:43-64`（HMAC cookie，ACCESS_CODE 未设则放行）
- 本地缺失硬依赖：`lib/choreography/`、`lib/media/{resolve-media-ref,media-task-resolution,slide-media-slots,resolve-audio-bytes,use-asset-url,polled-task,media-ref}.ts`、`lib/document-store/`、`lib/store/video-render.ts`
- 本地安全设施：`lib/server/api-guard.ts:60`、`lib/server/course-access.ts:22`、`lib/server/ssrf-guard.ts`、`lib/server/proxy-fetch.ts`
