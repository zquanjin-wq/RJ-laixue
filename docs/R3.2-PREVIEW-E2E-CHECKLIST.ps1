# R3.2 Preview E2E 验证脚本
# 部署完成后，在 PowerShell 中执行此脚本

# 1. 设置 Preview URL（部署完成后替换）
$PREVIEW_URL = "https://rj-laixue-XXXXXX.vercel.app"

# 2. 检查环境变量（部署的 Preview 必须包含 NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK=1 和 NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ=1）
# 这需要在 Vercel UI 配置，无法用脚本检查

Write-Host "=== R3.2 Preview E2E 验证 ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "前置：用户已部署 test/r3-line @ 416747e2 到 Vercel Preview"
Write-Host "前置：Preview env NEXT_PUBLIC_RUNTIME_SHADOW_PLAYBACK=1 + NEXT_PUBLIC_RUNTIME_SHADOW_QUIZ=1"
Write-Host ""

# 3. 探测：/api/runtime/v1/config（如果存在）—— R3.x 阶段
try {
  $config = Invoke-RestMethod -Uri "$PREVIEW_URL/api/runtime/v1/config" -Method GET -TimeoutSec 5
  Write-Host "[config] $($config | ConvertTo-Json -Depth 2)"
} catch {
  Write-Host "[config] 未部署或权限拒绝（这是正常的——R3.x 阶段）" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== 后续手动验证步骤 ==="
Write-Host ""
Write-Host "A. Quiz 验证（必须使用真实账号登录到 Preview）："
Write-Host "  1) 打开任意含 Quiz 场景的课件 → 进入 Quiz 场景"
Write-Host "  2) F12 → Network 面板 → 清空记录"
Write-Host "  3) 填写答案 → 点 '提交'"
Write-Host "     期望看到（按顺序）:"
Write-Host "       POST /api/runtime/v1/sessions                    (create_session)"
Write-Host "       POST /api/runtime/v1/sessions/.../records       (append_record, id 包含 ':submit')"
Write-Host "       PATCH /api/runtime/v1/sessions/.../status        (set_status, status=completed)"
Write-Host "  4) 等批改结果显示 → 期望看到:"
Write-Host "       POST /api/runtime/v1/sessions/.../records       (append_record, id 包含 ':grade', payload.phase=reviewed)"
Write-Host "  5) 点 '重试' → 期望看到:"
Write-Host "       PATCH /api/runtime/v1/sessions/.../status        (set_status, status=archived)"
Write-Host ""
Write-Host "B. IndexedDB 验证（关键！）："
Write-Host "  F12 → Application → IndexedDB → MAICDatabase"
Write-Host "  表 runtimeChainHeads:"
Write-Host "    - 应有 1 行: sessionId='qa:<stage>:<scene>:<attempt>', tailEntryId=<UUID>"
Write-Host "    - 一次完整流程后 tailEntryId 应指向 archived set_status entry"
Write-Host "  表 runtimeOutbox:"
Write-Host "    - 成功流程结束后应为空（或无 pending）"
Write-Host "  表 succeededEntries:"
Write-Host "    - 全部 5 个 entryId 都是 UUID，不是 'r3quiz:tail:*'"
Write-Host ""
Write-Host "C. 遥测验证："
Write-Host "  Network 面板搜 'client-diagnostics'"
Write-Host "  期望 event='runtime_dual_read' 不出现（R3.x 阶段）"
Write-Host "  期望 event='runtime_shadow' 仍按旧路径发送（chat/playback 不回归）"
Write-Host ""
Write-Host "D. 无回归验证："
Write-Host "  - 打开 Chat 场景 → 发消息 → 仍走 R2 shadow（无 outbox 入队）"
Write-Host "  - 播放课件 → 进度更新 → 仍走 R3.1 playback outbox（不依赖 quiz 子开关）"
Write-Host ""
Write-Host "完成后反馈结果（截图或文本），我据此生成验证报告。" -ForegroundColor Green