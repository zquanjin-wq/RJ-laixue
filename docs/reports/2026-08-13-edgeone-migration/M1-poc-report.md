# M1 POC 报告：首次 EdgeOne 构建失败与修复

**编号**: MIG-EO-M1-1
**日期**: 2026-08-13
**状态**: 🟡 修复已推送至 EdgeOne Preview 分支；等待重新部署。
**生产影响**: 无

## 1. EdgeOne 首次构建证据

EdgeOne 已成功加载 `@edgeone/opennextjs-pages` 插件和图片优化 Loader，随后在 `StaticAssetsBuilder` 阶段失败：

```text
[e]-188 Builder Error: SyntaxError: Expected double-quoted property name in JSON
at position 551 (line 24 column 7)
```

日志中的运行时为 Node `v22.11.0`，满足项目 `>=20.9.0` 和 `.nvmrc` 的 Node 22 基线。

## 2. 根因

根 `tsconfig.json` 的 `compilerOptions.paths` 中含 JSONC 行注释。TypeScript/Next.js 能解析 JSONC，但 EdgeOne 当前 OpenNext 静态资源构建器使用严格 `JSON.parse`，因此在第 24 行注释处失败。

该失败发生在应用编译之前，与环境变量、Supabase、AI 提供商密钥和业务代码无关。

## 3. 修复

仅移除 `tsconfig.json` 中 `@openmaic/storage` 路径映射前的说明注释；保留所有配置值、路径别名和 TypeScript 行为不变，使该文件同时兼容 TypeScript JSONC 与严格 JSON 解析器。

## 4. 本地验证

| 检查 | 结果 |
|---|---|
| 严格 JSON 解析 | 通过 |
| `pnpm exec tsc --showConfig --pretty false` | 通过 |
| `pnpm build` | 通过，耗时约 113 秒 |
| Next.js 产物 | 73 个静态页面生成完成，全部 API Route Handler 完成编译 |

构建仅显示既有 Next.js 提示：`middleware.ts` 文件约定已弃用，建议使用 `proxy.ts`。该项进入 M2，不阻断本次 JSON 修复验证。

## 5. 下一步与门禁

1. 已推送分支：`origin/migration/edgeone-m1`，提交 `fa21142723704e12b71d3abaa53d93769fbde194`。
2. 将 EdgeOne 项目的部署分支切换为 `migration/edgeone-m1`，或从该分支手动创建 Preview 部署。
3. 验收点：越过 `StaticAssetsBuilder` JSON 解析阶段，记录完整构建耗时、最终部署包体与 Preview URL。
4. 若下一次失败指向其他 JSONC 文件，按同样原则只转换被 EdgeOne 读取的配置文件，并在每次修改后执行本地生产构建。

## 6. 边界

- 未绑定自定义域名，未修改 Cloudflare DNS。
- 未写入 EdgeOne Secret，未使用 Production Supabase。
- 已在负责人授权后创建并推送非生产分支；未合并 `main`，未触发生产 DNS 或生产环境变量变更。
