# Spike 实测结果：extract-document 异步化选路

日期：2026-08-07

## 路径 A2：浏览器直传 MinerU presigned URL

| 验证项 | 结果 | 证据 |
|--------|------|------|
| 创建 batch → 获取 presigned URL | ✅ 成功 | batch_id: 7210b301 |
| CORS preflight (OPTIONS) | ❌ 403 | `Access-Control-Allow-Origin: (missing)` |
| PUT with Origin 头 | ❌ 403 | SignatureDoesNotMatch — Origin 破坏 OSS 签名 |
| Server-style PUT（无 Origin） | ✅ 200 | 基线对照：Vercel 可以传 |

**结论：不可行。** MinerU 的阿里云 OSS presigned URL 签名不含 Origin 头，浏览器强制加 Origin → 签名不匹配 → 403。

## 路径 A1：URL模式 — MinerU 从 Supabase 拉取文件

| 验证项 | 结果 | 证据 |
|--------|------|------|
| 创建 URL 模式 task batch | ✅ 成功 | batch_id: 08f9ac17 |
| MinerU 拉取 Supabase public URL | ✅ 成功 | 438 字节测试 PDF 被正确解析 |
| 状态流转 | ✅ pending → done | 几秒完成 |
| ZIP 结果下载 | ✅ 成功 | 2.1 KB ZIP 可下载 |

**结论：可行。** 用公开 URL `https://{project}.supabase.co/storage/v1/object/public/course-assets/{path}`。

## 选定路径：A1（URL 模式）

- 文件字节完全不走 Vercel：MinerU 直接从 Supabase CDN 拉取
- 不需要浏览器 PUT：无 CORS 问题
- 不需要签名 URL：`course-assets` bucket 是 `public:true`，公开 URL 即可
- 保持与现有 sign-upload 直传一致的架构哲学
