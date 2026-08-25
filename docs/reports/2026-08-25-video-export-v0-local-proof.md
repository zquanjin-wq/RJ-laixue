# 视频导出 V0.0 本地渲染证明 — BLOCKED

- 日期：2026-08-25
- 分支：`test/video-export-v0-local-proof`
- 基线：`chore/video-export-v032-audit` HEAD `c41ac51c89674c95778404830561f1e245614dec`
- 上游基准：`v0.3.2`（commit `673af150`）
- 状态：**BLOCKED**（环境不具备执行条件，未进入渲染验证）

---

## 1. 结论

本机不具备执行 `ZIP → Chromium → FFmpeg → MP4` 渲染链验证的必要环境，任务在**第 1 步（确认 Docker 可用）即被阻断**。未修改上游源码、未部署云服务、未执行 SQL、未改环境变量、未连接 Production。

## 2. 阻断点

| 依赖 | 期望 | 实际 | 影响 |
|---|---|---|---|
| Docker | `docker --version` 可用 | **未安装**：`docker`/`podman`/`docker-compose` 均不在 PATH，`C:\Program Files\Docker\`、`D:\Program Files\Docker\`、`D:\Docker\`、`%LOCALAPPDATA%\Docker` 均不存在 | render-service 是 Docker 容器（Node 22 + Chromium headless shell + FFmpeg），无 Docker 无法构建/运行 |
| ffprobe / ffmpeg | 可解析 MP4 | **未安装**：均不在 PATH，无常见安装路径，`node_modules` 无 `ffmpeg-static`/`ffprobe-static` | 无法对产物 MP4 做第 11–12 步验证 |
| WSL | 可作 Docker Desktop 后端 | **被安全策略禁用**：`wsl` 属系统级工具，当前安全策略已禁用（提示需在安全中心调整「系统级工具」策略） | 排除了「WSL2 内跑 Docker」的替代路径 |
| Node | — | v22.22.2 可用（WorkBuddy 自带） | 仅此一项满足，但不足以复现渲染链（Chromium/FFmpeg 需容器或系统安装） |

## 3. 执行情况

| 步骤 | 结果 |
|---|---|
| 1. 确认 Docker 可用并记录版本 | **阻断**（Docker 未安装） |
| 2–16. 提取 render-service / 构建 / 运行 / health / render / status / download / cancel / ffprobe / 抽帧 / SHA-256 / 404 / cancel | **未执行**（前提不满足） |

## 4. 最小修复建议（需负责人授权，不在本任务范围）

1. **安装 Docker Desktop**（含 WSL2 后端），并在安全中心放行「系统级工具」以启用 WSL；或
2. **提供一台已具备 Docker（Linux）的构建/验证机**，在其上执行本任务；或
3. 如坚持本机验证，另案授权安装 FFmpeg（含 ffprobe）用于产物校验。

上述均为系统级安装/环境变更，超出本任务「不安装系统级软件」的授权边界，故未自行执行。

## 5. 是否允许进入 S3

**否（BLOCKED）**。S3（本地课件 → ZIP → MP4 端到端）以 V0.0 本地渲染证明通过为前提，当前 V0.0 本身未完成。

## 6. 交付完整性说明

因阻断发生在执行第 1 步，本报告无法提供：MP4 文件大小/SHA-256、ffprobe 摘要、抽帧检查、峰值内存/耗时、jobId、download/cancel 结果。这些项在环境就绪后需重新执行并补录。

---

- 产品代码改动：否
- 上游源码修改：否
- 云部署 / SQL / 环境变量 / Production 操作：否
- 清理：无（未启动任何容器或临时产物）
