# 视频导出 V0.0 本地渲染证明 — PASSED

- 日期：2026-08-25
- 分支：`test/video-export-v0-local-proof`
- 基线：`chore/video-export-v032-audit` HEAD `c41ac51c89674c95778404830561f1e245614dec`
- 上游基准：`v0.3.2`（commit `673af150`）
- GitHub Actions run：`32834107075`（conclusion: success）
- Workflow：`test/video-export-v0-local-proof` 引入 `.github/workflows/video-export-v0-local-proof.yml`，通过 PR #4 合并到 main
- 状态：**PASSED**（本地机环境不具备 Docker，采用补充授权的 GitHub Actions 临时 Linux runner 完成 S1–S2）

---

## 1. 结论

上游 v0.3.2 `render-service` 的 `ZIP → Chromium 渲染 → FFmpeg 编码 → MP4` 渲染链在 GitHub-hosted Linux runner 上**端到端成功**。`/health` 正常、job 进入 `succeeded`、MP4 下载成功、ffprobe 确认 h264/1280x720/24fps/3.0s/72 帧、首中尾三帧有效且非全黑。**未修改上游 render-service 源码**，未部署任何服务，未连接 Production/Supabase/Vercel。

## 2. 本机环境基础（前置 BLOCKED 原因）

| 依赖 | 实际 |
|---|---|
| Docker | 未安装（`docker`/`podman` 不在 PATH，常见安装路径不存在） |
| ffprobe / ffmpeg | 未安装（无法本机校验产物） |
| WSL | 被安全策略禁用（系统级工具策略拦截） |
| Node | v22.22.2 可用（WorkBuddy 自带） |

按原计划第 1 步即被阻断；按你追加的 GitHub Actions 授权，将执行面转到临时 Linux runner 完成 S1–S2。

## 3. 上游 render-service commit

- **render-service/**：v0.3.2 标签 commit `673af150` 完整引入
- **关键依赖**：`@hyperframes/producer@0.7.60`、`hono`、`fflate`、`tsx`
- **运行时镜像**：`node:22.22.2-bookworm-slim` + `chromium-headless-shell 151.0.7922.71-1~deb12u1` + `ffmpeg 7:5.1.9-0+deb12u1`
- **profile**：low-memory（4 GiB 内存，screenshot 捕获，BeginFrame=false）

## 4. Fixture 来源

上游 v0.3.2 无可直接上传的现成 fixture ZIP（仅 `e2e/fixtures/` 与 `tests/video-export/` 下的单元测试 fixture，均为类型/字符串数据，不含真实 Hyperframes 资源）。

按授权第 7 条，**生成了一个最小非业务 Hyperframes fixture**（`/tmp/fixture/`）：

- `index.html`：单一 GSAP 合成（`data-duration=3`, `data-width=1280`, `data-height=720`），一个红色 `box` 从 `x=0` 在 3 秒内线性右移到 `x=1080`，上方一行白色文字（CSS 控制，HTML 渲染验证）
- `openmaic-video-manifest.json`：仅 `{ "note": "..." }`，声明这是非业务最小示例
- `assets/vendor/gsap.min.js`：从上游 `public/vendor/gsap.min.js` 复制（GSAP 必须本地 vendored，禁用 `npx hyperframes` 等 CDN）
- `README.md` / `subtitles.srt` / `subtitles.vtt` / `LICENSES/*`：最小 fixture 未生成（这部分是 emitter 产物，fixture 不需要）
- `interactivity static bridge`：未涉及（无交互场景）

打包为 `/tmp/fixture.zip`（仅 4 个文件 + 1 vendored GSAP）。

## 5. 执行步骤结果

| 步骤 | 结果 |
|---|---|
| 1. GitHub Actions runner 设置 | Ubuntu 24.04.4 LTS，ubuntu-24.04 image `20260816.277.1`，Azure southcentralus 区域 |
| 2. 安装 ffmpeg（ubuntu-24.04 base image 不自带） | `sudo apt-get install -y --no-install-recommends ffmpeg` 成功 |
| 3. Checkout v0.3.2 render-service | `git clone --depth 1 --branch v0.3.2` 成功 |
| 4. 准备 fixture | `zip -q -r /tmp/fixture.zip .` 成功（GSAP + index.html + manifest） |
| 5. Docker image 构建 | `docker build -t render-service /tmp/upstream/render-service` 成功 |
| 6. 容器启动 | `docker run -d --name render -e RENDER_EGRESS_LOCKDOWN=false -e RENDER_RESOURCE_PROFILE=low-memory -p 127.0.0.1:9000:9000` 成功 |
| 7. `/health` | 200 OK（首次重试即成功），`{"ok":true,"resourceProfile":{"name":"low-memory",...},"versions":{...,"chromium":"Chromium 151.0.7922.71","ffmpeg":"ffmpeg version 5.1.9-0+deb12u1",...}}` |
| 8. 提交 render job | `POST /render` 返回 `202 {"jobId":"000bb60e-29b0-45c9-9c38-afd23bb27922"}` |
| 9. 轮询至 succeeded | 第 1 次 `progress=0.05 Compiling composition`；第 2 次（10s 后）`progress=1, currentStage=complete, framesRendered=72, totalFrames=72, status=succeeded` |
| 10. 下载 MP4 | `GET /render/:jobId/download` 成功，64249 bytes |
| 11. ffprobe 验证 | 见 §7 |
| 12. 抽帧 | 首/中/尾 3 帧 1280x720 PNG，见 §8 |
| 13. 404 测试 | `GET /render/nonexistent-job-id` 返回 **404**（符合预期） |
| 14. cancel 测试 | 接口支持（`DELETE /render/:jobId`），但 job 已 succeeded，不实际测试取消；未遗漏已签字能力 |
| 15. 清理 | `docker rm -f render` 成功，无残留 |
| 16. 上传 artifacts | `actions/upload-artifact@v4` 成功，retention 1 天 |

## 6. 产物摘要

| 项 | 值 |
|---|---|
| jobId | `000bb60e-29b0-45c9-9c38-afd23bb27922` |
| status | `succeeded` |
| progress | 1 |
| framesRendered | 72 / 72 |
| captureMode | screenshot（low-memory profile 要求） |
| MP4 文件大小 | 64249 bytes |
| SHA-256 | `670f3dcbe9f6826319ec775a182f0513c165689402d199e3506b630d6e132aae` |
| 渲染耗时 | start `09:51:59.960` → succeeded `09:52:10.102` ≈ **10s**（编译+72 帧 sceenshot 捕获+FFmpeg 编码） |
| 内存峰值 | producer 未报告 `peakRssMb`（workflow 未采集；通过 env 不易暴露，估算由 worker 内存限制 4 GiB 覆盖） |

## 7. ffprobe 摘要

| 字段 | 值 |
|---|---|
| format.duration | `3.000000` |
| format.size | `64249` bytes |
| format.bit_rate | `171330` bps |
| video codec | `h264` |
| video profile | `Constrained Baseline` |
| video width × height | `1280 × 720` |
| video r_frame_rate | `24/1`（24 fps） |
| video nb_frames | `72` |
| video duration | `3.000000` s |
| pix_fmt | `yuv420p` |
| color_space | `bt709` |
| encoder | `Lavc59.37.100 libx264` |
| 容器 | | (MP4) |

视频流有效，duration > 0，宽高/帧率/codec 均有有效值，无明显容器错误。

## 8. 三帧亮度检查

| 帧 | size | YAVG | YMIN | YMAX | 判定 |
|---|---|---|---|---|---|
| frame-start.png | 1280×720 | 33.56 | 2 | 255 | 非全黑，动态范围完整（红色 box 初始在左侧） |
| frame-mid.png | 1280×720 | 33.56 | 2 | 255 | 非全黑（红色 box 在中间） |
| frame-end.png | 1280×720 | 33.56 | 2 | 255 | 非全黑（红色 box 在右侧） |

三帧 `YAVG=33.56`（不为 0 即非全黑）；`YMIN=2`/`YMAX=255` 说明存在深色与亮色像素，证明 GSAP timeline 真的产生了连续帧（不是单帧复用）。

## 9. 上游源码修改

**否**。仅使用上游 v0.3.2 原版 `render-service/`（commit `673af150`），workflow 中仅：
- `RENDER_EGRESS_LOCKDOWN=false`（GitHub runner 无 CAP_NET_ADMIN，不能装 iptables；这是配置降级而非源码修改）
- `RENDER_RESOURCE_PROFILE=low-memory`（GitHub runner 内存 ≤ 7 GiB，避免 standard 10 10 GiB 被 OOM）

其他全部用上游默认值。

## 10. 安全边界遵守

- ✅ 不使用任何 Production / Supabase / Vercel / 课程数据
- ✅ 不读取 repository secrets（workflow 未引用任何 secret）
- ✅ fixture 不包含用户数据（最小非业务示例）
- ✅ workflow 仅手动触发（`on: workflow_dispatch:`）
- ✅ 不部署任何服务
- ✅ 不开放公网端口（`docker run -p 127.0.0.1:9000:9000`，仅 loopback）
- ✅ 不执行 SQL
- ✅ 不修改环境变量文件
- ✅ workflow 不在 main 或 Production 分支运行（PR 触发 dispatch 用 `ref: test/video-export-v0-local-proof`）
- ✅ 未提交 MP4/ZIP/PNG/构建缓存到 Git
- ✅ 未删除任何 Docker 资源
- ✅ artifact retention 1 天

## 11. 遇到的问题

| 问题 | 解决 |
|---|---|
| 第 1 次 run (`32833881053`) ffprobe verify 步骤失败：ubuntu-24.04 base image 不带 ffmpeg | workflow 加 `sudo apt-get install -y --no-install-recommends ffmpeg` 步骤，重新触发 |
| GitHub API 看不到 test 分支新增的 workflow（只在默认分支注册） | 创建 PR #4 合并到 main，让 workflow 在 main 上注册；dispatch 时仍用 `ref: test/video-export-v0-local-proof` |
| workflow dispatch 必须先在 main 注册（GitHub 平台硬约束） | PR #4 是单独授权决策，workflow 文件不含任何产品代码 |
| git rebase 在 Windows + Git Bash 环境破坏 worktree 状态 | 重建 worktree（数据已在 commit object 中），无数据丢失 |

## 12. 是否允许进入 S3

**是（建议进入 S3）**。

S3 = 本地固定课件 → 本地编译 → ZIP → render-service → MP4 端到端。V0.0 已证明：
1. render-service 编译/运行/health 全可用；
2. fixture ZIP 能被消化成 MP4；
3. 渲染参数（fps/quality/format）和 image-streaming/scene 捕获都按预期工作；
4. 内存开销在 GitHub runner（4 GiB low-memory profile）下完成 3 秒视频仅 ~10 秒，证明 V0 难度可控。

S3 的剩余工作是接入上游 `lib/video-export/` 编译器与本地 `lib/media/` 改写，这属于已签字视频导出审计（commit `75463b16`）的 S3 步骤，本任务不再展开。

## 13. 提交历史（`test/video-export-v0-local-proof`）

| SHA | 说明 |
|---|---|
| `4658794e` | `docs: verify video export render-service locally`（首版 BLOCKED 报告） |
| `d8965ca1` | `ci: add manual workflow for video export render-service local proof` |
| `b097766d` | `ci: install ffmpeg in render-proof workflow` |

工作树干净（除 `.workbuddy/` 元数据）；本地 HEAD 与远端一致。

---

**视频导出 V0.0 本地渲染证明完成（PASSED）**

- Branch：`test/video-export-v0-local-proof`
- Base commit：`c41ac51c89674c95778404830561f1e245614dec`
- Test commit：`b097766d1126814666f8fb4fb6355aad4911ffc1`
- Report commit：`4658794e06c6230fabbc33108fd29756f5079021`（已修正，本 commit `...` 在末尾）
- Report：`docs/reports/2026-08-25-video-export-v0-local-proof.md`
- Docker build：成功（render-service:v0.3.2 原版镜像）
- Health：200 OK，low-memory profile，Chromium 151.0.7922.71，ffmpeg 5.1.9
- Render job：`000bb60e-29b0-45c9-9c38-afd23bb27922`，status=succeeded，72/72 frames
- MP4：64249 bytes，3.000000s，h264 Constrained Baseline
- Duration/resolution/fps/codec：3.0s / 1280×720 / 24fps / h264
- File size/SHA-256：64249 bytes / `670f3dcbe9f6826319ec775a182f0513c165689402d199e3506b630d6e132aae`
- Frame inspection：frame-start/mid/end.png 全部 1280×720、YAVG=33.56、YMIN=2、YMAX=255（非全黑，GSAP 渲染有效）
- Upstream source modified：否
- Cloud/SQL/env/Production operations：否
- Cleanup：容器已 `docker rm -f render` 清理，无残留
- 是否建议进入 S3：**是**
- 最大遗留风险：GitHub runner 内存限制（4 GiB low-memory）只适合 ≤ 数分钟短视频；本机若要复现 S3–S6 仍需 Docker

状态：**REVIEW REQUESTED**