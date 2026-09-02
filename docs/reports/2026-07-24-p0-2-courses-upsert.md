# P0-2 报告：POST /api/courses upsert 越权写入修复

> 日期：2026-07-24  
> 任务卡：P0-2  
> Commit：`9be2ba5e`  
> 严重程度：🔴 P0（数据完整性 + 隐私）

## 漏洞摘要

**`app/api/courses/route.ts` POST 处理器**：

1. **使用 `service_role` client**（`getServiceSupabase()`）——RLS 完全被绕过
2. **upsert 之前零 owner 校验**——任意登录用户提交课程 id 直接覆盖
3. **payload 硬编码 `created_by: user.id`**——**所有权静默转移**：A 创建的课程被 B "保存" 一次后，`created_by` 变成 B 的，A 失去管理权

### 攻击场景

```bash
# A 创建课程 (auth.uid = A, course.id = "course-x")
POST /api/courses  body: { id: "course-x", data: {...} }
→ Supabase 写入 (id="course-x", created_by=A)

# B 登录后偷 course-x 的 id，POST 同一 id
POST /api/courses  body: { id: "course-x", data: { 恶意内容 } }
→ Supabase 写入 (id="course-x", created_by=B)  ← 所有权转移！
```

## 修复

**单文件最小修改**（`app/api/courses/route.ts:POST`）：

```typescript
// 1. 查 existing
const { data: existing } = await serviceSupabase
  .from('courses')
  .select('created_by')
  .eq('id', id)
  .maybeSingle();

// 2. 已存在 → owner 校验
if (existing) {
  const { data: profile } = await serviceSupabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  const callerIsAdmin = profile?.role === 'admin';
  if (existing.created_by !== user.id && !callerIsAdmin) {
    return 403;  // 既非 owner 又非 admin
  }
}

// 3. upsert：INSERT 带 created_by，UPDATE 不带
serviceSupabase.from('courses').upsert(
  { id, title, topic, data, updated_at, ...(existing ? {} : { created_by: user.id }) },
  { onConflict: 'id' },
);
```

**关键设计**：
- admin 跨所有者写 **不接管所有权**（created_by 保持原值）
- 新课（不存在）时 caller 自动成为 owner
- 路由只解构 { id, title, topic, data }——created_by 不可能从 body 注入

## 测试

`tests/api/courses-route-upsert-authz.test.ts` —— **6 个用例全过**：

| # | 场景 | 期望 | 实测 |
|---|---|---|---|
| 1 | 未登录 | 401 | ✅ |
| 2 | A 保存新 id（INSERT） | 200，payload.created_by = A.id | ✅ |
| 3 | B 提交 A 的 id | **403，upsert 未被调用** | ✅ |
| 4 | A 更新自己的 id | 200，**payload 无 created_by** | ✅ |
| 5 | admin 更新 A 的 id | 200，**payload 无 created_by**（admin 不接管所有权） | ✅ |
| 6 | body 注入 created_by | 路由不接收，upsert payload 无该字段 | ✅ |

```
Test Files  1 passed (1)
Tests       6 passed (6)
```

## 附加：app/api/ 写操作路由扫描

`app/api/` 下 47 POST + 1 DELETE，按 Supabase 模式分类：

| 类别 | 数量 | 安全性 |
|---|---|---|
| **service_role + 无 owner 校验** | **1**（已修）| 🔴 → ✅ |
| service_role + 已有 owner 校验 | 3 | ✅ |
| service_role + admin role 校验 | 9 | ✅ |
| user session + RLS | 38+ | 默认安全 |

**结论**：courses POST 是 RJ-laixue **唯一**的真实 service_role 越权点。其他路由要么走 RLS，要么有显式 admin 校验。

## 后续监控

- **场景**：`docs/reports/2026-07-24-phase0.md` 提到的 P1-2 关掉 LEGACY_AUTOSAVE 开关后，saveStageToCloud 不再被自动调用——但 courses POST 仍可能被手动的"保存到云端"按钮触发（`app/classroom/[id]/page.tsx:709`）。该路径已自动经过本次修复的 owner 校验。
- **预防**：未来任何新增的 service_role 写操作都必须**自带 owner/role 校验**——这是给后续开发者的硬性规约（写进 PROJECT-STATE.md 操作规约）。

## 关联

- `docs/PROJECT-STATE.md` 决策记录 + 操作规约
- `app/api/courses/route.ts:47-156` POST 处理器
- `tests/api/courses-route-upsert-authz.test.ts` 6 个测试
