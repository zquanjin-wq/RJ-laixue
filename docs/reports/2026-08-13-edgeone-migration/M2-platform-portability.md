# M2 任务卡：平台可移植性改造

**编号**: MIG-EO-M2
**前置**: M1 Go
**状态**: ⏸️ 待开工确认
**预计**: 2–3 天
**生产权限**: 无

## 1. 任务目标

把 Web 主应用从“Vercel 配置可运行”改造成“本地、Vercel、EdgeOne 均可构建”，并将平台差异收敛在配置层。

## 2. 实施清单

- [ ] 按 Next.js 16 与 EdgeOne 实测结果，将 `middleware.ts` 迁移为 `proxy.ts` 或记录保留理由。
- [ ] 新增并校验 `edgeone.json`，迁移 headers、rewrites、redirects 和缓存规则。
- [ ] 保留 `vercel.json` 直至 M7；不得为了 EdgeOne 破坏 Vercel 回滚。
- [ ] 固定 Node/pnpm 版本和构建命令，消除 `pnpm@latest` 漂移。
- [ ] 建立平台能力适配层，禁止业务模块直接判断 Vercel/EdgeOne。
- [ ] 清理运行时读取仓库本地配置文件的隐式依赖；构建期静态资源必须显式打包。
- [ ] 对重依赖使用动态导入或路由隔离，降低普通 API 包体。
- [ ] 生成 EdgeOne Preview 所需环境变量清单和 secret 注入步骤。

## 3. 代码门禁

- `pnpm build` 在本地、Vercel Preview、EdgeOne Preview 三处通过。
- 关键普通 API 的部署包目标 < 100 MB；超过者必须有 M4 迁移归属和负责人批准。
- 静态检查、受影响单测、关键 API smoke test 全绿。
- EdgeOne 配置不得包含 Secret、账号 ID 或只适用于个人账户的绝对路径。

## 4. 交付物

- 平台配置代码与测试。
- `M2-portability-report.md`：三平台构建结果、包体变化和偏离说明。
- 更新后的路由归属矩阵。
- 运维文档：如何建立新的 EdgeOne Preview。

## 5. 边界与回滚

- ❌ 不修改生产 DNS、Supabase schema 或生产环境变量。
- ❌ 不在本阶段重写长任务业务逻辑。
- 所有改动必须保持 Vercel Preview 可用；回滚为撤销 M2 代码提交。
