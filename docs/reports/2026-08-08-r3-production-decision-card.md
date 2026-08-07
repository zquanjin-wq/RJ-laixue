# R3.x → Production 决策卡

**日期**: 2026-08-08
**起草**: Kimi（Codex 角色）
**状态**: ⏸️ 待负责人拍板
**前置**: R3.1a Preview E2E 通过（`6f658d84`）｜R3.2 Quiz Preview E2E 通过（`2026-08-05-r3.2-preview-e2e-acceptance.md`）｜R3.0-C1 签字（`8f048f21`）

---

## 1. 当前状态一句话

RuntimeStore 全线（chat/quiz/playback 影子写 + outbox + visit 生命周期）已在 **Preview 全量验证通过**；Production 目前**零影子流量**——无 runtime 表、无开关、main 分支无 runtime 代码。上生产需要三把钥匙同时转动：**合并代码 + 生产 SQL + 生产环境变量**，缺一不可，也互不授权。

## 2. Preview 已验证清单（事实基础）

| 能力 | 证据 | 状态 |
|---|---|---|
| R2 chat/quiz 影子写 | R2 签字（`30c71f01`）+ Preview 受控开启验收 | ✅ |
| R2.1 playback 影子写（双开关） | A1/A2 签字（`3faccb3a`）+ Preview E2E | ✅ |
| R3.0-C1 outbox 409 分类兜底 | C1-1~C1-7b 门禁 39/39 | ✅ |
| R3.1a visit 生命周期 | Preview E2E：两完整播放周期 **零 409**，outbox 全排空 | ✅ |
| R3.2 quiz outbox | Preview E2E 通过 | ✅ |

## 3. 已知未决风险（拍板前必读）

| # | 风险 | 严重度 | 处置建议 |
|---|---|---|---|
| F-1 | chat lecture 消息「同 id 不同内容」→ 无限 409 循环（调查报告 `3f1ba6e7`） | 中：无用户可见故障，但生产开启后每堂播放课产生 409 噪音 + chat 影子数据残缺 | **先修 M1 止血卡再开生产**（小改动：遇 IDEMPOTENCY_CONFLICT 游标跳过 + 计数） |
| M-1 | main 分支已大幅前进（PDF 异步化、TTS 四卡、保存修复），`test/r3-line` 停在 8/6 | 合并冲突风险 | 先把 main 合入 test/r3-line，跑全量门禁，再回合 main |
| O-1 | 旧 outbox 终结方案未定案 | 低：仅影响旧版本客户端残留条目 | 不阻塞生产开启，另案 |
| D-1 | client-diagnostics 400 调查未完成 | 低 | 不阻塞，另案 |

## 4. 上生产的三个开关（各自独立授权）

| 钥匙 | 内容 | 回滚方式 |
|---|---|---|
| ① 代码合并 | `main → test/r3-line` 合并 + 门禁 → 回合 `main` → Vercel 自动部署。**代码自带双开关默认关闭，部署本身零行为变化** | 正常迭代 |
| ② 生产 SQL | 生产 Supabase 执行 `supabase-runtime-store-v1.sql`（3 表 + RLS + 14 RPC），与 Preview 已验收脚本同源 | 表保留不 DROP，断流量即无害 |
| ③ 环境变量 | Vercel Production 设 `NEXT_PUBLIC_RUNTIME_SHADOW=1` + `NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK=1` | **秒级回滚：删变量 redeploy，本地 Dexie 体验完全不受影响** |

## 5. 决策项（请逐项拍板）

**D1. 总体路线** — 推荐 **A**
- A. 分步：先 M1 止血卡（chat 409）→ 合并 main 双向对齐 → 生产 SQL → 开影子写观察一周
- B. 直接开：接受 chat 409 噪音，M1 后补
- C. 暂缓：等旧 outbox 终结方案一并定案

**D2. 生产 SQL 授权边界** — 推荐：**授权仅 `supabase-runtime-store-v1.sql` 单文件**，执行前比对与 Preview 已验收版本逐字节一致；不含任何业务表变更

**D3. 观察期** — 推荐：开启后 **7 天**，Kimi 每周出 runtime_shadow 遥测摘要；异常（409 率 >1%、RPC 错误）只关开关，不动表

**D4. 首期范围** — 推荐：chat + quiz + playback **全量**（三者在 Preview 均已验收；playback 子开关同步开）

## 6. 执行顺序（拍板后）

1. M1 止血卡 → 验收 → 合 test/r3-line
2. main → test/r3-line 合并 + 全量门禁 + tsc
3. 回合 main（Vercel 自动部署，开关默认关，零变化）
4. 生产 SQL（单独签字执行单）
5. 生产环境变量 → 观察期开始

---

**起草人签字**: Kimi（Codex 角色）｜2026-08-08
**待**: 负责人对 D1–D4 拍板
