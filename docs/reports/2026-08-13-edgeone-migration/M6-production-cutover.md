# M6 任务卡：生产切流

**编号**: MIG-EO-M6
**前置**: M5 Go + 负责人书面授权
**状态**: ⏸️ 未授权
**预计**: 1 天
**生产权限**: 有，逐项签字

## 1. 任务目标

将生产域名从 Vercel 受控切换到 EdgeOne，保证代码、数据和任务所有权一致，并能在 15 分钟内恢复 Vercel。

## 2. 独立授权项

下列四项必须分别签字，不得用一次口头确认替代：

| 授权 | 内容 | 回滚 |
|---|---|---|
| A | 部署 production release commit 到 EdgeOne/Worker | 回滚到上一 deployment |
| B | 执行已验收的 Production SQL | 关入口；表保留，不紧急 DROP |
| C | 写入 Production Secrets 与 feature flags | 恢复旧值并重新部署 |
| D | 修改生产 DNS/CNAME | 指回 Vercel 目标 |

## 3. 切流前 24 小时

- [ ] 冻结架构和 schema 改动，确定唯一 release commit。
- [ ] Vercel 与 EdgeOne 部署同一 commit，双端 smoke test 通过。
- [ ] DNS TTL 降至 300 秒，并验证旧记录可恢复。
- [ ] 导出 DNS、证书、环境变量名称和 feature flag 快照。
- [ ] 清空或记录迁移前任务队列，明确每个任务的执行所有者。
- [ ] 确认 EdgeOne、Worker、Supabase 告警与值守人在线。
- [ ] 确认 Vercel 项目、域名配置和付费状态至少保留 7 天。

## 4. 切流步骤

1. 暂停非必要发布和批量重任务入口。
2. 执行授权 A，记录 EdgeOne/Worker deployment ID。
3. 执行授权 B，只运行逐字节验收过的 SQL。
4. 执行授权 C，保持高风险能力默认关闭。
5. 用临时生产验证域名完成最终 smoke test。
6. 执行授权 D，将生产 CNAME 指向 EdgeOne。
7. 观察 DNS、生效节点、证书、5xx、登录和任务创建。
8. 30 分钟稳定后逐项开启重任务 feature flag。
9. 连续观察 4 小时后结束现场值守，进入 M7。

## 5. 立即回滚条件

发生以下任一情况，不等待进一步分析，立即回滚 DNS 和高风险 feature flag：

- 连续 5 分钟 5xx > 2%；
- 登录、建课、保存、发布任一核心路径不可用超过 5 分钟；
- 出现任务重复执行、数据覆盖、越权或 Secret 泄露；
- 大陆主要运营商无法访问或证书异常；
- EdgeOne/Worker 日志不可用，无法判断生产故障范围。

## 6. 回滚步骤

1. 关闭 EdgeOne 新任务入口与重任务 feature flag。
2. 将 DNS/CNAME 恢复到切流前 Vercel 记录。
3. 验证 Vercel 登录、课程读取、保存和任务查询。
4. 已由 Worker claim 的任务继续处理，禁止 Vercel 重复 claim。
5. 宣布回滚完成并冻结进一步发布，保留所有日志取证。

数据库新表默认保留，不在事故窗口执行 DROP 或破坏性回滚。

## 7. 交付物与完成条件

- `M6-cutover-log.md`：每一步时间、执行人、结果和证据。
- DNS/配置变更记录、deployment ID、生产 smoke 结果。
- 切流后 4 小时指标摘要。
- 只有 4 小时内无 P0/P1 且未触发回滚条件，才可进入 M7。
