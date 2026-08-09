# ⚠️ DRAFT / NOT AUTHORIZED — Quiz Production 上线卡

**状态**: DRAFT — 未经任何授权。仅用于后续规划参考，禁止实施。
**前置**: 阶段 A（生产 shadow 观察期）通过
**起草日期**: 2026-08-09

---

## 1. 背景

R3.2 Quiz outbox 代码与 Preview E2E 已签字通过：
- 严格链：`create(active) → submitted → reviewed → completed → archived`
- runtimeChainHeads 表记录尾 entry
- 成功凭据、幂等退路均已覆盖
- Preview E2E 确认所有 5 个阶段写入成功

当前生产仅开启 Chat shadow + Playback outbox。Quiz 生产子开关处于**关闭状态**。

## 2. 上线步骤（阶段 B）

### B1：开启开关

```bash
# Vercel 环境变量（Production）
NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ=1
```

不修改任何其他变量。

### B2：无缓存部署

Vercel Production 部署 → 清除边缘缓存。

### B3：真实流程 E2E

按以下流程逐项验证，每项确认后继：

| # | 操作 | 期望 | 验证方式 |
|---|------|------|----------|
| 1 | 学员进入课堂，答题 | 本地 persisted | 浏览器 DevTools → Application → Dexie → quizAttempts |
| 2 | 提交答案 | outbox pending → sending → succeededEntries 凭据 | Dexie runtimeOutbox + succeededEntries |
| 3 | AI 批改完成 | reviewed 写入 | Vercel Logs `POST …/records` 200 |
| 4 | 查看批改结果 | 本地 reviewed 字段更新 | Dexie quizAttempts |
| 5 | 重试（retry） | archived 写入 | Vercel Logs `PATCH …/status` 200 |
| 6 | 刷新页面 | 本地恢复，不重新入队 | Dexie runtimeOutbox 无新增 |

### B4：链完整性核验

- [ ] 五个阶段严格顺序：create → submitted → reviewed → completed → archived
- [ ] runtimeChainHeads 尾 entry 正确
- [ ] succeededEntries 凭据无遗漏
- [ ] dependsOnEntryId 链无断裂
- [ ] 已完成 attempt 不重新入队

### B5：单独观察 3-7 天

- 每日检查 Quiz 维度 Runtime 4xx/5xx/409
- 检查 outbox pending 天数
- 检查链断裂（依赖缺失）实例
- 检查 completed 后重复操作处理

## 3. 回滚条件

| # | 条件 | 动作 |
|---|------|------|
| RQ1 | Quiz Runtime 5xx > 5% | 关闭子开关，重新部署 |
| RQ2 | 严格链断裂 > 1 次/天 | 关闭子开关，调查 |
| RQ3 | 本地课堂答题功能回归 | 关闭子开关，重新部署 |
| RQ4 | 任何 P0 数据完整性问题 | 关闭子开关 |

## 4. 不授权

- ❌ 切换 Quiz 读源（dual-read 阶段 E 之前）
- ❌ 修改 Quiz 相关 SQL / RLS / RPC
- ❌ 清理 Quiz 生产数据
- ❌ 修改 Chat 或 Playback 生产开关

---

**状态**: ⚠️ DRAFT — NOT AUTHORIZED
**审阅**: Kimi（Codex）
**生效条件**: 阶段 A 观察期通过 + Kimi 签字 + 负责人授权
