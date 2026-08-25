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

1. **`render-service/` 代码相对自包含（运行环境要求高）**：上游已把渲染服务做成**独立、opt-in**（`RENDER_SERVICE_URL` 未配置时降级为 ZIP 下载），代码与主 app 通过 HTTP 解耦，可整体复制。但其**运行环境要求高**（Node 22 + Chromium headless shell + FFmpeg + 4–10 GiB 内存 + `CAP_NET_ADMIN`），应标记为 **PORT_MANUALLY**，不能当「低风险直接复制」。需先本地跑通 ZIP→MP4 证明可行，再谈外部部署（见 §7）。
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
7. **鉴权（本地必须补，且不能只靠「教师 + 课程读权限」）**：上游 `app/api/export-video/**` 四个 route 无 per-user/per-course 鉴权，仅靠 `middleware.ts` 的 HMAC `openmaic_access` cookie（部署级共享口令，`ACCESS_CODE` 未设则放行）。本地是 admin/teacher/learner 三级 + RLS，且「能读取课程」≠「有权消耗渲染资源」。V0 的授权矩阵必须明确：
   - **admin**：允许；
   - **course owner/creator**：允许；
   - **普通 teacher（非 owner）**：默认拒绝，除非另有授权；
   - **learner**：拒绝；
   - **匿名分享用户**：拒绝。
   POST 创建任务时持久化 `userId`/`courseId`/`sourceRevision`/`jobId`；`status`/`download`/`cancel` 每次都要**重新验证绑定**，不能只凭 jobId。
8. **`lib/server/capped-stream.ts` 缺失**：上游 render route 依赖 `capBodyStream`（流式限字节上传），本地需补。

## 5. 是否需要独立 render-service

**需要，且是硬前提。**

`render-service` 需要 Node ≥ 22 + Chromium headless shell + FFmpeg + 4–10 GiB 内存 + `CAP_NET_ADMIN`（egress lockdown），渲染一个 10 分钟视频可耗时数十分钟。**Vercel 不适合作为当前主渲染环境**：
- 函数 `maxDuration` 300s（本地 `vercel.json` 已设 300s），远低于渲染时长；
- 函数时长、内存、包体、临时文件（`/tmp` 之外不可持久）和「长任务」模型都不适合承载这条渲染链——不是简单地「没有 Chromium/FFmpeg 运行时」能概括，而是整个 serverless 执行模型不匹配。

因此 render-service 必须独立部署（云 VM / 容器服务 / 自建服务器），主 app 通过 `RENDER_SERVICE_URL` 调用。这是本任务唯一的**外部资源**，也是最主要的工程前置项。

**部署细节（影响 V0 目标，需注意）**：
- 默认 `InMemoryJobStore`（进程内存 Map）+ `LocalDiskArtifactStore`（MP4 留 `/tmp/openmaic-renders` 本地磁盘，**不是 S3**），产物 TTL 30 分钟。S3/Redis 是上游标注的后续 swap 点，尚未实现。
- **jobId 不持久化**：`jobId` 是 `randomUUID()`，只存浏览器内存的 `lib/store/video-render.ts`（全局 zustand store，跨菜单存活），**无 localStorage/IndexedDB 持久化**，render-service **无 job 列表接口**。因此「关闭页面/刷新后恢复下载」在上游是**不支持的**——服务端渲染继续，但客户端拿不回 jobId（只能等 TTL 过期）。

## 6. 推荐的 V0 范围

**包含**：
- 教师导出自己的课程（`requireAuthOrTeacher` + `checkCourseReadAccess` 校验）
- 输出 MP4
- 文本、图片、音频、字幕、中文字体（Noto CJK）、KaTeX 公式、聚光指示

**V0 目标「页面关闭后继续、完成后回来下载」是本地必须补写的能力**（上游不支持）。仅持久化 jobId 只能解决「刷新找回 ID」，**不能解决服务端重启**（`InMemoryJobStore` 重启丢状态、`LocalDiskArtifactStore` 容器重建丢 MP4、Supabase 里留的 jobId 可能 render-service 已不认识）。既然是面向教师的正式功能，V0 采用**正式方案**（非轻量方案）：
- 持久化 job registry（render-service 任务状态可恢复或明确失败）；
- MP4 上传**持久对象存储**（非本地临时磁盘），本地临时文件只作处理中间物；
- worker 重启后能恢复或明确失败；
- 主应用保存 `userId`/`courseId`/`sourceRevision`/`jobId`/`outputKey` 绑定；
- 下载经鉴权或短期签名 URL；
- 跨设备下载有可靠产物（不依赖 render-service 容器存活）。

这是本地相对上游的**净新增**（上游 `InMemoryJobStore` + `LocalDiskArtifactStore` 都不满足），工作量需计入 V0，不能省略。

**暂不做**（与任务卡一致）：在线剪辑、多清晰度、学生导出、永久公开分享、自定义片头/水印、多语言重配音。

**明确推迟**：视频片段的真实播放渲染。上游虽支持 `play_video`（`passes/timeline.ts`），但依赖视频时长解析、首帧 poster 解码等复杂链路，且本地视频片段走 `lib/media/` 与上游不同。V0 采用「视频片段显示首帧/封面」，不渲染真实视频帧——与上游 Quiz/PBL 封面策略一致，风险可控。

## 7. 分成哪几步实施

**实施顺序以「本地渲染证明优先」为原则**：先本地跑通 ZIP→MP4，再谈外部部署，避免「先产生云资源/运维成本，最后才发现本地课件编译不出 render-service 能消费的 ZIP」。

1. **S1：本地启动上游 render-service**（PORT_MANUALLY，本地容器/进程，不部署外部资源）——复现 `@hyperframes/producer` 渲染链，确认 Node 22 + Chromium headless shell + FFmpeg 环境可搭建。
2. **S2：用上游固定 fixture 验证 ZIP → MP4**——不依赖本地课件，先证明 render-service 本身可用。
3. **S3：移植最小编译闭包**——`lib/video-export/` + `emit-hyperframes/` + `lib/choreography/`，补 `gen:video-export-katex`，适配 dsl `SceneContent` 漂移。
4. **S4：用本地固定课件生成 ZIP**——按本地 media 层改写 `collect.ts` + `timeline-deps.ts`（补齐 7+ 缺失 `lib/media/*` + `renderer/snapshot/measure.ts`），产出与上游同构的资产 plan。
5. **S5：本地完成 ZIP → MP4**——打通本地课件 → 编译 → render-service → MP4 的端到端链路。
6. **S6：基准测试**——内存、耗时、文件大小基线（决定后续资源画像与成本）。
7. **S7（仅 S1–S6 通过后）**：选择并部署外部容器服务 + 持久 job store + 持久 artifact store + 鉴权 + 关页恢复。

整体移植风险为**中等偏高**：上游缺失依赖的本地闭包较大（`lib/choreography`、`lib/media` 7+ 文件、`renderer/snapshot/measure.ts`、`lib/store/video-render.ts`、`lib/document-store`），不能只复制 `lib/video-export/` 单目录。

## 8. 是否建议现在开工

建议**有条件开工**，且以「本地渲染证明」为第一步：先在本地容器跑通上游 render-service + fixture ZIP→MP4，再移植编译链 + 本地课件 ZIP→MP4，**全部通过后再部署外部容器**。不先产生云资源/运维成本。前置风险是：render-service 运行环境要求高（Node 22 + Chromium + FFmpeg，PORT_MANUALLY）、鉴权矩阵需明确、collect 媒体解析改写量大。在本地渲染证明未通过前，不应进入外部部署。

---

## 结论

**GO WITH CONDITIONS** —— 现授权进入 S1–S2 本地渲染证明；S1–S6 全部通过后，才允许申请外部部署：

1. **本地渲染证明优先**：先在本地容器跑通上游 render-service + fixture ZIP→MP4，再移植编译链 + 本地课件 ZIP→MP4，全部通过后才部署外部容器。GO 的前提是「render-service 可在目标环境部署」，**不是「已经部署」**。
2. **鉴权矩阵已确认（owner 权限收紧）**：admin / course owner 允许；普通 teacher 非 owner 默认拒绝；learner / 匿名拒绝。POST 持久化 `userId`/`courseId`/`sourceRevision`/`jobId`，`status`/`download`/`cancel` 每次重新验证绑定，不能只凭 jobId。
3. **缺失依赖移植范围已评估**：确认 `lib/choreography`、`lib/media/` 7+ 文件、`renderer/snapshot/measure.ts`、`lib/store/video-render.ts`、`lib/document-store`（本地为 `document-bridge`）的本地依赖闭包可控。
4. **关页恢复采用正式 V0 方案**：持久 job registry + MP4 持久对象存储 + worker 重启恢复（或明确失败）+ 主应用保存 `userId/courseId/jobId/outputKey` 绑定 + 鉴权/短期签名下载。不接受只持久化 jobId 的轻量方案（无法覆盖服务端重启与跨设备下载）。

**验收门禁**（进入外部部署前必须通过）：
- 本地 fixture ZIP → MP4 成功；
- 本地固定课件 → ZIP → MP4 端到端成功；
- 内存/耗时/文件大小基准已记录；
- **容器重启恢复**：render-service 重启后，持久 job registry 能恢复任务状态或明确失败，持久 artifact store 中已完成的 MP4 仍可下载。

未满足前两条时，结论退化为 **NO-GO（暂缓）**。整体移植风险为**中等偏高**（非低风险），不能只复制 `lib/video-export/` 单目录。

---

### 附：安全风险清单（审计发现，供后续设计卡引用）

| 风险 | 上游现状 | 本地必须处理 |
|---|---|---|
| 课程权限 | render/download route 无 per-user/per-course auth；仅 `middleware.ts` HMAC `openmaic_access` cookie（部署级共享口令，`ACCESS_CODE` 未设则放行） | owner 矩阵：admin / course owner 允许，普通 teacher 非 owner 默认拒绝，learner / 匿名拒绝；POST 持久化 userId/courseId/sourceRevision/jobId，status/download/cancel 每次重验绑定 |
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
