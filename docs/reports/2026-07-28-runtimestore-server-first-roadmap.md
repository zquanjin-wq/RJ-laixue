# 拍板文档：RuntimeStore 服务端化提前（路线重排）

> 日期：2026-07-28
> 状态：**待拍板**
> 背景：2026-07-28 战略评审结论（已获认可）——把「全新、低风险、高价值」的
> RuntimeStore 服务端化提到「最难、风险最高」的 B2.3 DocumentStore 主读写切流之前。
> 本文档是该结论的落地路线图。

## 1. 提议一句话

**B2.3 切流评审之前，先把 RuntimeStore 的服务端持久化做出来**：课堂运行数据
（学员会话 + append-only 互动记录）今天只存在于各浏览器的 Dexie 里，换设备即丢失、
服务端零沉淀。这是全新写入路径——不迁移历史数据、不碰课程文档主路径、不改课堂
展示——风险远低于 B2 迁移，业务价值（学情数据、多端续学）反而最高。

## 2. RuntimeStore 契约摘要（已冷安装，B1 ✅）

上游 `@openmaic/storage`（#869 Part B，`a05ffc22`）提供的持久化契约：

- **RuntimeSession**：身份 + 生命周期，以 `(stageId, learnerKey)` 为分区键
  （多租户：一个 stage 有多个学员会话；无全局列举，列举按分区）；
- **RuntimeRecord**：会话下的 append-only 有序事实，`seq` 由存储在写入事务中
  分配（CAS 语义）；records 不独立带版本，版本线骑在父会话上；
- **版本线独立**：`runtimeDslVersion`（与文档线 `dslVersion` 机制分离），
  存储层自带写入盖戳、读取迁移、未来版本写保护；
- **payload 校验注入点**：per-kind validator 由应用注入（DSL 骨架只管
  `chat`/`quizAttempt`）——RJ 的自有 kind 需要自有 validator，
  与 widened scene kind 同一模式（已有先例：2026-07-28 方案 A）；
- `mergeLearner`：登录迁移用的跨 stage 合并（对应 6 位 access code 绑定
  已登录账号的场景）。

## 3. 已决策的架构约束（沿用，不重新讨论）

1. `learnerKey = Supabase auth.uid()`；access code 绑定到已登录账号，不是匿名身份；
2. 上游 reference server / `pg.ts` **不能直接部署**（无生产身份、授权、多租户隔离）；
3. 路线：上游 HTTP storage contract → RJ Next.js API routes → `api-guard` +
   Supabase Auth/RBAC/RLS → 可替换后端（云端 Supabase / 私有化 Postgres）；
4. 浏览器**不直接**用 PostgREST 实现 append-only/CAS——seq 分配、会话状态变更、
   RLS 判定全部在 RJ API 层完成。

## 4. 阶段划分（每阶段独立可验收、可回退）

| 阶段 | 内容 | 风险 | 验收 |
|---|---|---|---|
| **R0 设计评审** | Supabase schema（sessions/records 两表）+ RLS policies + seq/CAS 服务端分配 + 幂等键设计；核查上游 HTTP contract 在 v0.3.1 的契约形状是否稳定 | 纯文档 | 设计文档过评审 |
| **R1 服务端 adapter** | Next.js API routes 实现 RuntimeStore 契约（浏览器 HTTP backend client → routes → api-guard → Supabase）；RJ 自有 kind 的 payload validator；**只接测试，不接业务** | 低（无业务接入） | 契约测试对服务端实现全绿（复用上游 `runtime-contract.ts` 测试套件） |
| **R2 单业务线端到端（影子）** | 选一条最独立的业务线（建议 `quizAttempt`：写少读少、形状稳定）双写：Dexie（读源不变）+ RuntimeStore 服务端；失败静默回退 | 低（只读源不变） | Preview 实测 N 个测验会话全部落库、无课堂回归 |
| **R3 读切换 + 登录迁移** | 该业务线读源切到服务端；`mergeLearner` 处理 access code→账号绑定 | 中 | 双读比对（同 B2 模式）+ 单业务线灰度 |
| **R4 私有化后端** | 同一 HTTP contract 指向私有化 Postgres 实现 | 中 | 私有化环境契约测试全绿 |

R2 的业务线选择是拍板项：`quizAttempt`（推荐，写读最简单）vs `chat`
（价值最高但量大、形状随多智能体演进）。

## 5. 与 B2.3 / DocumentStore 服务端化的关系

- **并行不冲突**：RuntimeStore 动的是课堂运行数据（sessions/records），
  DocumentStore 动的是课程文档（stage/scenes）——数据、表结构、读写路径
  完全独立；
- **建议合并设计**：DocumentStore 服务端 adapter（B2.3 之后）与 R0 的 schema
  评审放在同一份设计文档里做——两者共享版本线机制、RLS 分区思路和
  api-guard 模式，分开设计会导致两套服务端风格；
- B2.3 切流仍按 B2.2 完工报告的门禁执行，不因本路线提前而豁免。

## 6. 风险与开放问题（拍板时逐条确认）

1. **上游 HTTP contract 稳定性**：v0.3.1 刚发，契约形状若仍在演进，
   R1 的 routes 需要版本化（URL 或 header），避免上游更新撕裂——R0 先核查；
2. **RLS 粒度**：learner 只能读写自己的 `(stageId, learnerKey)` 分区；
   教师的班级聚合视图走 service role + api-guard 授权，不走 RLS 例外；
3. **容量与成本**：append-only records 持续增长（chat 量大）——R0 需要
   留存/归档策略（或至少容量估算）；
4. **离线/弱网**：课堂网络不稳定时 append 失败——客户端 outbox + 重试
   （R2 影子期只丢影子写，R3 前必须解决）；
5. **私有化推论**：办公区 GFW 已影响 GitHub/Vercel——私有化部署环境
   大概率也不通 Supabase 云服务，R4 不是可选项而是必选项，只是先后问题。

## 7. 建议的立即下一步

拍板通过后：**R0 设计文档**（schema + RLS + CAS + 上游契约核查 + DocumentStore
服务端化合并设计），预计 1 个工作日，产出物为
`docs/reports/2026-07-XX-runtimestore-server-r0-design.md`，评审通过再动代码。

## 8. 路线图全景（更新后）

```text
上游存储包冷安装 ✅   场景顺序归一 ✅   B2.1 本地影子复制 ✅
B2.2 双读比对 ✅（2026-07-28 完工报告；历史 Dexie 全量离线验证收尾中）
RuntimeStore 服务端化（本文档）◀ 提前到这里
B2.3 DocumentStore 主读写切换（门禁满足后评审）
DocumentStore 服务端 adapter（与 R0 合并设计）
私有化可替换后端（R4）
```
