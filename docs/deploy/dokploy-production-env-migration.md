# laixue：Vercel → Dokploy 生产环境变量迁移表

本文只记录变量名称、用途和录入位置；**不记录、不得提交任何密钥值**。

## 结论

- 生产入口已于 2026-08-14 从 Vercel 切换至腾讯云香港 CVM 上的 Dokploy；详见 [生产切换记录](dokploy-production-cutover-2026-08-14.md)。
- Dokploy 的 **Environment** 是容器运行时变量；密钥和服务器端配置放这里。
- Dokploy 的 **Build-time Arguments** 是 Next.js 浏览器包构建期变量；所有需要保留的 `NEXT_PUBLIC_*` 放这里。
- 改 Build-time Arguments 后必须重新 Deploy；只改 Environment 也建议 Deploy，使新容器读取新值。

## A. 必须先补齐（当前业务已经验证会用到）

将下列变量放入 Dokploy 的 **Environment**。值从对应厂商控制台或原有安全存储取得，不要贴到聊天、Git 或文档。

| 变量 | 用途 | 取值来源 | 缺失影响 |
| --- | --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | 服务端访问 Supabase | Supabase 项目 API 设置 | 后台读写、上传等服务端能力失败 |
| `SUPABASE_URL` | 服务端 Supabase 地址 | Supabase 项目设置 | 建议与原生产一致 |
| `PDF_MINERU_CLOUD_API_KEY` | PDF 解析 | MinerU Cloud 控制台 | 当前已确认：PDF 生成失败 |
| `TTS_MINIMAX_API_KEY` | 语音生成 | MiniMax 控制台 | TTS 失败 |
| `TOKEN_PLAN_MINIMAX_API_KEY` | 课程规划/多模态预设 | MiniMax 控制台 | 课程生成能力不完整 |
| `MINIMAX_API_KEY` | 默认大模型（若生产默认模型为 MiniMax） | MiniMax 控制台 | AI 对话/生成失败 |
| `MINIMAX_BASE_URL` | MiniMax API 地址 | 复制原生产值 | 模型调用异常 |
| `DEFAULT_MODEL` | 默认模型选择 | 复制原生产值 | 模型路由异常 |

`NEXT_PUBLIC_SUPABASE_URL` 和 `NEXT_PUBLIC_SUPABASE_ANON_KEY` 不是服务器密钥，但也要保留在 **Environment**，以供服务器端回退使用；它们还必须同时放到下一节的 Build-time Arguments。

## B. 必须在构建时传入（生产网页行为）

把下列 **Production** 值放入 Dokploy 的 **Build-time Arguments**。有同名项在 Preview 的，不要取 Preview 值。

| 变量 | 来源 | 说明 |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel Production / Supabase | 浏览器连接 Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel Production / Supabase | 浏览器匿名登录与数据访问 |
| `NEXT_PUBLIC_RUNTIME_SHADOW` | Vercel Production | 运行时影子写总开关 |
| `NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK` | Vercel Production | 播放行为影子写开关 |
| `NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE` | Vercel Production | 文档存储桥接开关 |
| `NEXT_PUBLIC_DOCUMENT_STORE_PARITY_CHECK` | Vercel Production | 文档一致性校验开关 |
| `NEXT_PUBLIC_MAIC_EDITOR_ENABLED` | Vercel Production | 编辑器入口开关 |

如果 Vercel Production 中还配置了下面任一项，也放入 Build-time Arguments；没有配置则保持不填，应用会用默认安全行为：

`NEXT_PUBLIC_DSL_ASSET_GUARD_MODE`、`NEXT_PUBLIC_ENABLE_PPTX_IMPORT`、`NEXT_PUBLIC_LEGACY_AUTOSAVE`、`NEXT_PUBLIC_SHOW_VOCATIONAL_TEST_UI`。

## C. 按实际使用补齐，而不是默认全开

以下密钥在本地生产开发配置中存在。若 laixue 的正式功能仍要使用对应模型，就放入 Dokploy **Environment**；未使用则不导入：

| 变量 | 对应能力 |
| --- | --- |
| `KIMI_API_KEY` | Kimi 模型 |
| `DEEPSEEK_API_KEY` | DeepSeek 模型 |
| `OPENAI_API_KEY` | OpenAI 兼容模型（如生产实际使用） |
| `ACCESS_CODE` | 访问码功能（仅在已启用时） |
| `CRON_SECRET` | 定时任务接口（仅已配置定时任务时） |

图像、视频、语音识别和搜索供应商密钥也遵循同一原则：只有当前正式产品提供该能力、且 Vercel Production 中确实设置了对应 `*_API_KEY` 时才迁移。不要因为项目代码支持某供应商就填入所有密钥。

## D. 不迁移

| 变量 | 原因 |
| --- | --- |
| `PNPM_FROZEN_LOCKFILE` | Vercel 构建行为；Dockerfile 已确定依赖安装方式 |
| `ENABLE_EXPERIMENTAL_COREPACK` | Vercel 构建行为；Docker 镜像已启用 Corepack |
| 仅标记为 `Preview` 的任何变量 | 当前是生产迁移，不复制测试环境配置 |

## E. 验收顺序

1. 录入 A、B 两节变量并 Deploy。
2. 在 `https://hk.laixue.work` 依次验收：登录、上传 PDF、生成课程、TTS、课程保存与读取。
3. 任一项失败先查看 Dokploy 服务日志，补对应项；不改 `laixue.work` DNS。
4. 所有验收通过后，单独制定并执行域名切换与回滚步骤。
