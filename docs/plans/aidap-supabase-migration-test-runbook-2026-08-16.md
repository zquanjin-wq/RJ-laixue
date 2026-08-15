# laixue：AIDAP Supabase 迁移测试执行计划

**计划日期：** 2026-08-16  
**适用范围：** 现有 Supabase（东京 Free）迁移至火山引擎 AIDAP Supabase 版的可行性验证、测试迁移、正式切换与回滚。  
**当前原则：** 腾讯云香港 CVM + Dokploy + Cloudflare 已是稳定生产链路；在 AIDAP 完整验收前，不修改生产 Supabase 环境变量，不停止原 Supabase，不再次切换域名。

## 1. 最终目标与本轮阶段目标

### 最终目标

在不丢失账号、课程、学习记录和文件的前提下，把 laixue 的 Supabase 依赖迁至可在国内付款、长期扩容的服务，并保留可验证、可回滚的发布流程。

### 明早唯一阶段目标

证明 AIDAP 是否具备承载 laixue 的资格。资格包括：

1. 能稳定进入 Supabase 控制台，或有可替代的管理接口。
2. 能取得 SDK URL、anon key、service role key，以及 PostgreSQL 迁移连接信息。
3. 能以合成数据验证 Auth、数据库/RLS/RPC、Storage 和管理员 API。
4. 香港 CVM 到北京 AIDAP 的延迟和稳定性可接受。

**明早不以“把生产数据搬过去”为目标。** 上述四项没有全部通过，就不做 pg_dump 恢复、不创建付费 DTS 任务、不修改 Dokploy 生产变量。

## 2. 当前已确认状态

### 生产侧

- `laixue.work` 与 `www.laixue.work` 已指向腾讯云香港 CVM，并由 Cloudflare 代理。
- 应用部署在 Dokploy，登录、PDF 识别、课程生成和大模型调用已验收。
- 原 Vercel 不再承载正式流量，仅暂时保留为回退资产。
- 原 Supabase 东京 Free 仍是正式数据源，当前运行正常。
- 原 Supabase 数据库密码今晚重置过；应用使用 SDK key/service role，不依赖该密码，因此生产未受影响。

### AIDAP 测试侧

- Workspace：`laixue-migration-dev`，Workspace ID：`valid-cress-31393218`。
- 分支：`main`，Branch ID：`br-solid-seal-57fd3968`，北京地域，运行中。
- SDK 公网地址与 anon key 已可获得；这只能证明应用 SDK 入口存在，不能代替 PostgreSQL 迁移连接。
- AIDAP 原生“SQL 查询”对 Supabase 引擎提示暂不支持。
- Supabase 控制台直接打开时出现 `ERR_INVALID_AUTH_CREDENTIALS`，登录框一闪而过，当前管理入口未验通。
- DTS 表单曾打开但没有提交、没有创建任务、没有产生 DTS 任务费用。
- 尚未创建业务表、导入数据或修改生产配置。

### 源数据基线

- Auth 用户：32。
- Storage：公开桶 `course-audio`、`course-assets`。
- 核心数据包括 32 个 profiles、32 个 students、17 个 courses、602 个 task_learning_events；完整表基线见 [迁移资产基线](../deploy/aidap-supabase-migration-inventory.md)。

## 3. 今晚尝试的结论

1. 源库只读盘点有价值，已经形成验收基线。
2. 直接在 CVM 上运行 `pg_dump` 为时过早：源库连接认证失败，且目标侧管理与恢复能力尚未验明。没有数据被修改。
3. 直接进入 DTS 为时过早：DTS 需要源、目标两侧的 PostgreSQL 主机、端口、账号和密码；AIDAP SDK URL/anon key 不是这些信息。
4. DTS 的 PostgreSQL 迁移不能被当成“完整 Supabase 迁移”：Auth 用户及密码、Storage 二进制对象、Supabase 配置仍需分别验证和迁移。
5. AIDAP 控制台登录异常是当前第一个阻塞项。继续绕过它试恢复或迁移，只会增加变量。

## 4. 明早执行总览

| 顺序 | 任务 | 预计耗时 | 通过后 | 不通过时 |
| --- | --- | ---: | --- | --- |
| A | 恢复 AIDAP 管理入口 | 15–30 分钟 | 进入 B | 停止迁移，提交工单 |
| B | 取得并核验四类连接凭据 | 15 分钟 | 进入 C | 停止迁移，提交工单 |
| C | 用合成数据做兼容性探针 | 30–45 分钟 | 进入 D | 判定不兼容或先整改 |
| D | 测试 HK CVM → 北京 AIDAP 网络 | 15 分钟 | 选择迁移机制 | 暂不迁移或调整架构 |
| E | 选定迁移机制并做小规模演练 | 1–2 小时 | 安排全量测试迁移 | 保留原 Supabase |

任务 A–D 是“迁移资格考试”；任务 E 以后才是真正的数据迁移。

### 人机分工

**你只做：** 登录火山/腾讯/Supabase 控制台、在密码框输入或重置密码、确认工单提交、确认明确展示价格的付费任务，以及最终业务体验验收。  
**我来做：** 代码依赖核对、连接测试、兼容性探针、迁移与校验脚本、日志判断、数据差异报告、Dokploy 配置清单和回滚检查。  
**禁止做法：** 我不再让你把大段命令逐行粘贴到终端；如确需一次受控执行，我先说明目的、影响、完整命令、预期输出和失败处理，再由自动化助手或我可控的入口执行。

## 5. 明早任务卡

### A. 恢复 AIDAP Supabase 管理入口

**目的：** 确认目标不是一个只能给 SDK 地址、却无法管理 Auth/Storage/数据库的黑盒。

**操作：**

1. 火山控制台进入 `AIDAP → Workspaces → laixue-migration-dev → 分支管理 → main → 分支总览`。
2. 确认 Workspace 和分支均为“运行中”，且“Supabase 公网连接”显示已开启。
3. 在“Supabase 控制台”卡片中再次“配置/重置”控制台账号密码。使用全新密码，保存到密码管理器，不粘贴到聊天或终端。
4. 只从卡片的“进入”按钮打开控制台，不手工复制控制台 URL。
5. 若仍是一闪而过并出现 `ERR_INVALID_AUTH_CREDENTIALS`，立即停止重试；记录北京时间、Workspace ID、Branch ID、错误截图和浏览器错误码，提交 AIDAP 工单。

**成功标准：** 能进入 Supabase Studio，看到 Authentication、Storage、Table Editor/Database 等模块。  
**失败标准：** 重置一次后仍无法输入账号或仍报同一错误。  
**停止条件：** 失败后不再尝试 SQL、恢复数据或 DTS；等待火山支持修复。

**工单核心描述：** “从 AIDAP 分支总览点击 Supabase 控制台‘进入’，Basic Auth 登录框短暂出现后自动失败，浏览器报 ERR_INVALID_AUTH_CREDENTIALS；已重置 Workspace 控制台账号密码，仍无法输入。请检查控制台反向代理的 Basic Auth/账号同步状态。”

### B. 取得并核验四类连接信息

**目的：** 把应用连接与数据库迁移连接分开，避免再拿错凭据。

**操作与成功信号：**

| 类别 | 取得位置 | 只验证什么 |
| --- | --- | --- |
| SDK URL + anon key | 分支总览 → Supabase 公网连接串 → 连接 | 浏览器 SDK 可初始化；不记录明文到文档 |
| service role key | Supabase 控制台项目设置/API，或 AIDAP“获取变量”入口 | Admin API 能列出测试用户；绝不进入前端变量 |
| PostgreSQL 连接 | 分支总览 → 算力 Primary → 更多/连接信息，按官方“获取算力的连接信息” | 主机、端口、数据库、账号、密码齐全；只做连接测试 |
| 控制台账号 | 分支总览 → Supabase 控制台 → 配置 | 仅用于 Studio 登录，不等于 PostgreSQL 密码 |

**成功标准：** 四类信息都能区分并分别工作。  
**失败标准：** 找不到 PostgreSQL endpoint/账号，或 service role 无法获取。  
**停止条件：** 任意一项失败，先提工单；不创建 DTS。

### C. 合成数据兼容性探针

**目的：** 不碰生产数据，先证明 laixue 真正依赖的 Supabase 能力在 AIDAP 可用。

**探针对象：** 全部使用 `aidap_probe_*` 名称，测试后可删除。

1. **数据库：** 创建测试表、主键、外键、索引、触发器和一个 RPC 函数。
2. **RLS：** 开启 RLS，配置“登录用户只能读自己数据”的策略；分别用 anon、登录用户和 service role 验证权限。
3. **Auth：** 创建一个临时用户，验证密码登录、刷新 session、管理员列用户、重置密码、禁用/启用和删除。
4. **profiles 触发器：** 新用户创建后自动产生 profile；确认 UUID 一致。
5. **Storage：** 创建公开测试桶，上传小 PDF 和音频，验证列表、下载、公开 URL、覆盖和删除。
6. **SDK：** 用仓库当前 `@supabase/supabase-js` 版本执行 CRUD、RPC、Auth 和 Storage 调用。

**成功标准：** 六项全部通过，且没有依赖 AIDAP 不支持的手工特例。  
**失败标准：** Auth Admin、RLS/RPC 或 Storage 任一核心能力不可用。  
**停止条件：** 不用真实数据“试试看”；记录具体失败接口，先判断代码可改还是平台不兼容。

### D. 香港 CVM 到北京 AIDAP 的网络验收

**目的：** AIDAP 在北京、应用在香港；功能可用不代表生产体验可接受。

**操作：**

1. 在香港 CVM 对原 Supabase 与 AIDAP 各执行同一组 30 次健康请求、Auth 请求和简单数据库查询。
2. 记录成功率、平均耗时和 P95；同时观察 DNS/TLS/连接超时。
3. 从中国大陆常用网络执行登录、课程列表和一次保存的人工体验测试。

**通过线：** 30 次请求无超时、成功率 100%；AIDAP P95 不高于原 Supabase P95 的 1.5 倍且人工操作无明显卡顿。  
**需评估：** 超过 1.5 倍但仍可用，先在预览环境完整压测。  
**失败线：** 有持续超时、失败率超过 1%，或登录/保存明显影响使用。  
**失败后：** 不切生产；评估将应用也迁至境内已备案环境，或选择与香港网络更匹配的数据库方案。

### E. 迁移机制选择与小规模演练

只有 A–D 全部通过才选择以下路径，不并行乱试。

#### 首选：完整 PostgreSQL 导出/恢复 + 独立 Storage 复制

适用条件：目标 PostgreSQL 连接可用，允许恢复所需 schema/扩展/角色，且能迁移 Supabase Auth 系统数据。

1. 从源库生成当前完整 schema、角色/权限和数据 dump；历史 `supabase-*.sql` 只作审计，不作唯一真相。
2. 先恢复到 AIDAP 测试分支。
3. 单独复制 Storage 对象；数据库中的 storage metadata 不能代替文件内容。
4. 验证 Auth 密码登录。如果 `auth.users` 及密码哈希无法兼容，立即放弃“无感迁移”，改用经用户确认的密码重置方案。

#### 备选：DTS 结构 + 全量 + 增量

适用条件：源/目标 PostgreSQL 连接及权限通过预检查，并已由小样本证明对象兼容。

- 迁移对象优先按“库/schema”而不是零散表选择，否则视图、触发器、函数可能不迁。
- 不忽略预检查告警。
- DTS 只承担 PostgreSQL 范围；Auth 行为和 Storage 文件仍单独迁移与验收。
- 创建前再次确认计费；小数据量优先短时按量任务，完成后停止并释放。

#### 不采用：边试边改生产环境变量

`NEXT_PUBLIC_SUPABASE_*` 会进入 Next.js 构建产物，切换必须重新构建部署；不能靠运行时临时改回。任何 AIDAP 测试均使用独立 Dokploy 预览服务和独立域名。

## 6. 全量测试迁移与验收

### 测试拓扑

- 正式服务：继续使用 `laixue.work` + 原 Supabase。
- AIDAP 预览：新建独立 Dokploy service，例如 `laixue-aidap-preview`，使用 AIDAP 的三项环境变量。
- 预览域名：使用独立子域名，不覆盖 `laixue.work` 与 `www.laixue.work`。

### 数据完整性

1. 核对全部业务表数量，至少与资产基线一致。
2. 抽样核对主外键、UUID、时间字段和 JSON 内容。
3. 核对函数、触发器、索引、约束、RLS policy 和 sequence。
4. 核对 32 个 Auth 用户 ID、邮箱、禁用状态及与 `profiles` 的关联。
5. 用至少一个现有测试账号验证原密码登录；不使用真实学员账号做破坏性测试。
6. 对两个 Storage 桶核对对象数量、总字节数和对象路径；抽样计算哈希。

### P0 业务旅程

- 教师/管理员登录和 session 刷新。
- 创建、禁用、启用、重置教师或学员账号。
- 课程列表、创建、读取、修改、删除测试课程。
- 上传 PDF、MinerU 解析、模型生成课程、保存并重新打开。
- 上传/播放课程音频，公开素材 URL 可访问。
- 创建学习任务、分配学员、记录学习事件和查看进度。
- 手机端课程列表与学习页面。

任何 P0 失败，都不进入生产切换。

## 7. 正式切换方案

### 切换前一天

1. 原 Supabase 保持运行并确认可回滚。
2. 完成一次测试全量迁移与所有验收，输出差异报告。
3. 导出最新 schema/data 备份，并独立保存 Storage 清单。
4. 预约低峰维护窗口，通知可能的短暂停写。
5. 在 Dokploy 准备一份“原 Supabase 环境变量”回滚版本；不在文档或聊天记录密钥。

### 切换窗口

1. 开启维护/停写，阻止新课程和学习事件写入。
2. 做最终增量同步或最终 dump/restore。
3. 再次核对表行数、Auth 用户和 Storage 清单。
4. 将正式 Dokploy 的 URL、anon key、service role key 一次性切到 AIDAP，并重新构建。
5. 先做服务端健康检查，再做登录、课程读取、PDF 上传与保存四项冒烟。
6. 全部通过后解除停写；持续观察 2 小时。

### 回滚触发条件

- 登录失败或 session 大面积失效。
- 课程/PDF/音频无法读取或保存。
- 数据行数/Storage 对象出现未解释差异。
- 5xx 或超时率超过 1%，持续 5 分钟。
- P95 明显超过验收线并影响使用。

### 回滚动作

1. 重新进入维护/停写。
2. 恢复 Dokploy 中原 Supabase 三项变量并重新部署上一已验收镜像。
3. 验证登录、课程读取和保存。
4. 保留 AIDAP 现场用于排查，不在确认数据安全前删除任何一侧。
5. 对 AIDAP 切换期间产生的少量写入做清单，之后人工合并；本项目不在未设计前引入双写。

## 8. 凭据与成本规则

- 今晚曾暴露在聊天或终端截图中的数据库/API 密钥，在迁移稳定后统一轮换；service role 和大模型密钥按最高优先级处理。
- 密码只输入产品密码框或本机安全提示，不粘贴聊天、不回显终端、不写入 Git。
- AIDAP 测试 Workspace 在验证期间可能持续产生用量；如果平台阻塞超过一天，保存证据后停止不必要算力。
- DTS 创建前必须显示任务规格和预计费用；演练完成即停止并释放。
- Docker 拉取的 `postgres:17` 镜像只是工具镜像，不是额外数据库服务；后续可在确认无任务依赖时清理，但不属于明早第一优先级。

## 9. 三轮审核记录

### 第一轮：技术完整性审核

**检查项：** Auth、数据库结构、RLS、RPC、service role、Storage 文件、SDK、构建时变量、跨地域网络。  
**发现：** 原方案把 PostgreSQL 数据迁移等同于 Supabase 整体迁移，遗漏 Auth 密码兼容和 Storage 二进制对象。  
**修订：** 将迁移拆成 PostgreSQL、Auth、Storage 三条独立验收线；增加合成数据探针和跨地域延迟闸门。

### 第二轮：操作安全与回滚审核

**检查项：** 是否会误伤生产、是否可停止、是否有回滚、是否控制费用和密钥泄露。  
**发现：** 在目标管理入口未通时执行 dump/DTS 会增加无效操作；直接替换生产变量会把验证和切换混在一起。  
**修订：** 明确 A–D 未通过不得搬真实数据；要求独立 Dokploy 预览服务；增加停写、最终同步、回滚阈值和密钥轮换任务。

### 第三轮：人工可执行性审核

**检查项：** 明早是否能按顺序执行、每一步是否有目的/操作/成功信号/失败处理、是否需要临场猜测。  
**发现：** “进入连接信息”“验证一下”等表述不足以操作，且失败后容易继续尝试其他入口。  
**修订：** 写明 AIDAP 控制台路径、四类凭据差异、每关停止条件；把第一个失败处理固定为一次重置后提交工单，不再现场绕路。

## 10. 明早开工口令

明早只做任务 A。你打开：

`AIDAP → Workspaces → laixue-migration-dev → 分支管理 → main → 分支总览`

然后告诉我“已到分支总览”。我会一次只指导这一关，并在每次回复中固定给出：

1. 当前要达到的结果；
2. 你需要点击或输入的完整内容；
3. 成功与失败分别长什么样；
4. 成功后的下一步，或失败时立即停止的位置。

## 11. 官方依据

- [AIDAP：登录 Supabase 控制台](https://www.volcengine.com/docs/87275/2105837)
- [AIDAP：获取算力的连接信息](https://www.volcengine.com/docs/87275/2105829)
- [AIDAP：API 列表（数据库账号、endpoint、访问控制）](https://www.volcengine.com/docs/87275/2105871)
- [AIDAP：使用 Authentication](https://www.volcengine.com/docs/87275/2288737)
- [AIDAP：使用 Storage](https://www.volcengine.com/docs/87275/2277057)
- [DTS：创建 PostgreSQL 数据迁移任务（含 AIDAP Supabase 目标）](https://www.volcengine.com/docs/6390/172960)
- [DTS：PostgreSQL 迁移类型与对象范围](https://www.volcengine.com/docs/6390/79328)
