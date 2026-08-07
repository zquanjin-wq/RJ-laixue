# 修复卡：新课首存被 sign-upload「课程不存在」404 阻断

**编号**: FIX-2026-0807-save-course-404
**下达日期**: 2026-08-07
**下达方**: Kimi（Codex 角色）
**执行方**: WorkBuddy
**目标分支**: **main**（生产；⚠️ 不是 test/r3-line）
**拍板方案**: A（客户端 Phase 0 先建行）
**根因报告**: 见本文件 §1

---

## 1. 根因（已确认）

- 生产 main 于 2026-07-28 合入上游 50MB 上传重构（`3d80b985`），`app/api/course-assets/sign-upload/route.ts` 新增校验：真实 courseId 必须已存在于 `courses` 表，否则 404 `课程不存在`（`pbl-*` / `pending-*` 命名空间豁免）。
- 客户端 `lib/utils/cloud-sync.ts` `saveStageToCloud` 时序：Phase 1 发布语音（调 sign-upload）→ Phase 2 校验 → Phase 3 才 `POST /api/courses` 建行。
- 新课首存：Phase 1 全部上传 404 → Phase 2 校验出 missing-audio-url → 抛错 → 建行永远执行不到。老课保存不受影响。
- 用户实证：2026-08-07 新建课程首存，166 条 `课程不存在` + 18 处 `missing-audio-url`。
- 注意：本地两个仓库（RJ-laixue / RJ-laixue-storage-b2）的 sign-upload 仍是旧版无校验代码，**本地和 Preview 复现不了**，必须对着生产 main 修。

## 2. 修复方案（方案 A）

`lib/utils/cloud-sync.ts` 的 `saveStageToCloud` 增加 Phase 0：

```ts
// ── Phase 0: 确保云端课程行存在（新课首存时 sign-upload 需要 courses 行做鉴权）──
const probe = await fetch(`/api/courses/${encodeURIComponent(id)}`);
if (probe.status === 404) {
  // 建行：data 用当前 stage/scenes 原样（语音未发布也可接受——最终 POST 会覆盖完整数据）
  const createResp = await fetch('/api/courses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, title, topic, data: { stage, scenes, outlines } }),
  });
  await readApiJson(createResp);
} else if (!probe.ok) {
  throw new Error(`课程云端状态检查失败（HTTP ${probe.status}）`);
}
// probe 200 → 老课，直接继续
```

**已核实的前提**（实施时复核并写入报告）：
- `POST /api/courses` 是 service_role upsert（`onConflict: 'id'`），重复建行安全
- Phase 0 建行后，sign-upload 的 `created_by` 校验对建行人自然通过（created_by = 当前用户）
- 竞态：两标签页同存一门新课 → 两边 POST 都是 upsert，无破坏

**不得动的部分**：
- ❌ 不改 sign-upload 路由（上游校验保留；b2 R3 线将来合并时也保留）
- ❌ 不改 Phase 1-3 语音发布/校验/最终 POST 逻辑
- ❌ 不改移动端 AudioPlayer 的 missing-audio-url 兜底

## 3. 门禁

1. 单测（mock fetch）：
   - 新课首存：GET 404 → POST 建行 → 语音发布 → 最终 POST；**断言首个 sign-upload 请求发生在建行 POST 之后**
   - 老课保存：GET 200 → 不发建行 POST，后续流程不变（回归）
   - GET 非 404 错误（如 500）→ 抛错终止，不静默继续
2. 既有保存链路测试全绿 + tsc 零新增
3. 合并 main 后**生产实测**：新建一门课 → 生成语音 → 保存成功；老课保存回归

## 4. 部署与合并注意

- 改动落在 main 线，走正常 PR/合并 + Vercel 生产自动部署
- R3 线（test/r3-line）不含此修复；将来双向合并时注意：main 的 sign-upload 存在性校验 + 本 Phase 0 是一组配套，必须一起存在
- 生产验证通过后回复验收：构建号 + 新课首存成功截图/日志

---

**下达方**: Kimi（Codex 角色）｜2026-08-07
