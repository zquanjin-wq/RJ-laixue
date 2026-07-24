commit 6287ae23588881b45e826a86fdbcaaefed9e8ffa
Author: laixue-bot <laixue-bot@local>
Date:   Fri Jul 24 11:03:13 2026 +0800

    PR3: 生成超时机制（单页 3min + 整体 15min）
    
    之前 AI 接口卡住时，用户只能盯着 spinner 傻等。现在每个 outline
    独立 3 分钟 watchdog，整体批处理 15 分钟兜底。
    
    实现要点：
    1. 顶部常量
       - OUTLINE_TIMEOUT_MS = 3 * 60 * 1000
       - TOTAL_TIMEOUT_MS = 15 * 60 * 1000
    
    2. 两个 useRef
       - timeoutMapRef: Map<outlineId, NodeJS.Timeout>，每个 outline 独立
       - totalTimeoutRef: 整体批处理一个
    
    3. 5 个工具函数（在 hook 内，复用 store + t）
       - startOutlineTimeout(outline): 启动/重置单个 outline 的 3min timer
       - clearOutlineTimeout(id): 清除单个 timer
       - clearAllOutlineTimeouts(): 全部清除
       - startTotalTimeout() / clearTotalTimeout(): 整体 15min
    
    4. 启动点（2 处）
       - generateRemaining 主流程 setGeneratingOutlines(pending) 后
         批量 startOutlineTimeout(pending[i]) + startTotalTimeout()
       - retrySingleOutline setGeneratingOutlines([..., outline]) 后
         startOutlineTimeout(outline) + startTotalTimeout()
       幂等：startOutlineTimeout 内部先 clear 已有 timer，所以重试
       路径会重启 3min 预算，不会继承旧 timer。
    
    5. 清除点（5 处）
       - 早期 pending=0 完成路径
       - 正常完成路径（completed / paused-with-failed-continue）
       - generateRemaining finally 块（兜底 abort/throw 路径）
       - retrySingleOutline removeGeneratingOutline 内部
       - stop() 用户主动停止
    
    6. 失败包装函数 markOutlineFailed(outline)
       - 替代 7 处 store.getState().addFailedOutline(outline) 调用
       - 先 clearOutlineTimeout(id) 再 addFailedOutline
       - 保证失败时 timer 一定被清，避免下次重试时旧 timer 立刻
         fire 把刚 retry 的 outline 重新标记失败
    
    7. 超时触发行为（用户拍板）
       - 单页超时：addFailedOutline + 从 generatingOutlines 移除
         + toast.warning(标题)
       - 整体超时：所有仍 in-flight 的 outline 全部 addFailedOutline
         + 清空 generatingOutlines + setGenerationStatus('paused')
         + toast.error
       - **不动 scenes**（partial output 可恢复，重试逻辑自己判断）
    
    8. 8 个 locale 加 generation.timeout.{outlineTimeout,totalTimeout}
       共 16 个 key（8 × 2）。
    
    验收：
    - [x] 单 outline 3min 触发：failed + UI 红色 + 重试按钮
    - [x] 整体 15min 触发：所有在飞 outline 标 failed + paused
    - [x] 重试路径自动重启 timer（不会继承旧 timer）
    - [x] stop() / 异常 throw / abort 路径都正确清 timer
    - [x] TypeScript 零错误
    - [x] i18n 8 个 locale 对齐
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 lib/hooks/use-scene-generator.ts | 201 +++++++++++++++++++++++++++++++++++++--
 lib/i18n/locales/ar-SA.json      |   4 +
 lib/i18n/locales/en-US.json      |   4 +
 lib/i18n/locales/ja-JP.json      |   4 +
 lib/i18n/locales/ko-KR.json      |   4 +
 lib/i18n/locales/pt-BR.json      |   4 +
 lib/i18n/locales/ru-RU.json      |   4 +
 lib/i18n/locales/zh-CN.json      |   4 +
 lib/i18n/locales/zh-TW.json      |   4 +
 9 files changed, 226 insertions(+), 7 deletions(-)

commit 8b70ad9a9f6c35f1ef5c1af1ade2909cf5f970d4
Author: laixue-bot <laixue-bot@local>
Date:   Fri Jul 24 09:51:40 2026 +0800

    PR2: 生成过程实时进度 UI（每个 outline 状态可见）
    
    之前 generation 跑的时候，classroom 页只显示一个通用 spinner +
    "场景正在生成，请稍候..."，老师不知道哪几页已完成、哪几页还在
    等待、哪几页失败——只能盯着空白猜。
    
    改动：
    1. 新增 components/generation/GenerationProgress.tsx — 读
       useStageStore 的 4 个数组（outlines / scenes /
       generatingOutlines / failedOutlines），推导每个 outline 状态：
         failed     ← outline.id 在 failedOutlines
         completed  ← outline.order 在 scenes（materialized）
         generating ← outline.id 在 generatingOutlines
         pending    ← 其他
       渲染：每行一个 outline + 状态图标 + 状态文字 + 失败时显示
       "重试"按钮（通过 onRetryOutline prop 调 hook.retrySingleOutline）
       + 整体进度条 + X/Y 页��计 + 失败计数提示。
    
    2. components/canvas/canvas-area.tsx:136 — 把原本的 spinner +
       "场景正在生成" 替换为 <GenerationProgress onRetry={onRetryOutline} />。
       触发条件 isPendingScene && !currentScene && !isCourseComplete
       保持不变，确保只在真正生成中时显示。
    
    3. components/edit/PlaybackChromeRoot.tsx — 把已有的 onRetryOutline
       继续透传到 CanvasArea（之前只传到 PlaybackChromeRoot 自己用）。
       加新 prop onRetryOutline?: (id: string) => Promise<void>。
    
    4. 8 个 locale 加 generation.progress.* 命名空间（11 个 key）。
    
    为什么 hook 调用走 prop drilling（不在 GenerationProgress 内
    直接 useSceneGenerator）：
    - useSceneGenerator 内部用 useRef 持有生成状态，新调用会得到
      新的 hook 实例，丢失生成上下文。
    - retrySingleOutline 已经在 classroom page 调过一次，把同一个
      callback 透下去最简单可靠。
    
    验收：
    - [x] 每个 outline 状态实时更新（pending/generating/completed/failed）
    - [x] 显示"已完成 X / Y 页"
    - [x] 失败 outline 有重试按钮
    - [x] TypeScript 零错误
    - [x] i18n 8 个 locale 对齐
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 components/canvas/canvas-area.tsx            |  21 +--
 components/edit/PlaybackChromeRoot.tsx       |   1 +
 components/generation/GenerationProgress.tsx | 192 +++++++++++++++++++++++++++
 lib/i18n/locales/ar-SA.json                  |  15 ++-
 lib/i18n/locales/en-US.json                  |  15 ++-
 lib/i18n/locales/ja-JP.json                  |  15 ++-
 lib/i18n/locales/ko-KR.json                  |  15 ++-
 lib/i18n/locales/pt-BR.json                  |  15 ++-
 lib/i18n/locales/ru-RU.json                  |  15 ++-
 lib/i18n/locales/zh-CN.json                  |  15 ++-
 lib/i18n/locales/zh-TW.json                  |  15 ++-
 11 files changed, 310 insertions(+), 24 deletions(-)

commit ac91244ee57504eba75e0471bf5f17691e703608
Author: laixue-bot <laixue-bot@local>
Date:   Fri Jul 24 09:36:53 2026 +0800

    PR1: 生成完成后自动保存到云端（fire-and-forget）
    
    背景：当前 generation 完成 → 数据只在浏览器 IndexedDB → 必须老师
    手动点"保存到云端"才会写 Supabase。漏点或关页面 = Vercel 重启后
    数据丢失（Vercel /data 是 ephemeral filesystem）。
    
    修复：setGenerationComplete(true) 之后，调用新加的
    fireAndForgetAutoSave(stage.id) 工具函数，不阻塞后续流程。
    
    为什么 fire-and-forget（不 await）：
    - generation 已经够慢，saveStageToCloud 含音频发布，再叠加 5-30s
      阻塞会让用户盯着"生成中"看
    - 用户最关心的是"看到课程"，保存是后台事务
    - 失败有 toast 提示，老师还有手动"保存到云端"补救入口
    
    只挂在成功路径（setGenerationComplete(true) 之后）：
    - paused（有 outline 失败等重试）/ aborted 路径不触发
    - 避免上传半成品
    
    两处 setGenerationComplete(true) 调用点（pending=0 的早返回 +
    generateRemaining 主流程的 completed 分支）都加上。
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 lib/hooks/use-scene-generator.ts | 31 +++++++++++++++++++++++++++++++
 1 file changed, 31 insertions(+)

commit bfe7cae37e0bc43f1f9d2e5e89729bcb7659303a
Author: laixue-bot <laixue-bot@local>
Date:   Thu Jul 23 18:32:42 2026 +0800

    i18n: 修正老师主页文案位置（误改回滚 + 重新分配）
    
    上一轮 (0f345176) 误把"描述你想开发的课程..."改成 agentBar.readyToLearn
    ——但这个 key 是右上角 agent 折叠 pill 的文字（不是输入框上方的副标题）。
    用户截图反馈文案出现在"点击配置课堂角色"按钮旁，确认是误改。
    
    修正 5 处文案：
    
    1. agentBar.readyToLearn 回滚到 "准备好一起学习了吗？"
       （agent 折叠 pill 上的文字，不是副标题）
    
    2. agentBar.expandedTitle 改为 "介绍一下学员，AI 老师会根据学员
       的背景个性化教学"（展开态显示，引导老师描述学员）
    
    3. upload.requirementPlaceholder 重写为用户提供的版本：
       - 开头"描述你想开发的课程，AI 帮你生成完整课件。"
       - 中间"你可以这样描述："连接
       - 三条老师视角示例（新员工入职 / 锐捷交换机 / 销售谈判）
       - 移除上一轮多加的"📎 有课件、文档、案例..."上传提示行
         （用户的新版本里没要求，placeholder 已经够长）
    
    4. home.greetingWithName 保持 "你好，老师"（用户上一轮要求）
    5. home.enterClassroom 保持 "生成课程"（用户上一轮要求）
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 lib/i18n/locales/zh-CN.json | 6 +++---
 1 file changed, 3 insertions(+), 3 deletions(-)

commit 1b1163df82e5690dda0415c50ddbb9023cbbdc41
Author: laixue-bot <laixue-bot@local>
Date:   Thu Jul 23 18:11:38 2026 +0800

    e2e: 更新 home page enterButton fallback 文案
    
    按钮文案改为"生成课程"后，HomePage.enterButton 的中文 fallback
    从"进入课堂"同步更新。英文 fallback (`/enter/i` 匹配 en-US
    "Enter Classroom") 不变。
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 e2e/pages/home.page.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

commit 0f3451763ba80683d859d6a29e3fed2278870f0c
Author: laixue-bot <laixue-bot@local>
Date:   Thu Jul 23 17:55:53 2026 +0800

    i18n: 老师主页文案改为老师视角
    
    4 处文案修改（仅 zh-CN.json，纯文案，不动逻辑/样式）：
    
    1. home.greetingWithName: "嗨，{{name}}" → "你好，老师"
       （旧版"嗨，同学"是 displayName=默认昵称时的输出）
    
    2. agentBar.readyToLearn: "准备好一起学习了吗？" →
       "描述你想开发的课程，AI 帮你生成完整课件"
       （学习者视角 → 老师视角）
    
    3. home.enterClassroom: "进入课堂" → "生成课程"
       （按钮文案更贴切"创建"场景）
    
    4. upload.requirementPlaceholder: 学生视角示例（Python / 傅里叶变换 /
       阿瓦隆桌游）→ 老师视角示例（新员工入职 / 锐捷交换机 / 销售谈判），
       并在末尾加一行"📎 有课件、文档、案例？点击上传，AI 会优先基于
       你的资料生成"提示用户上传附件的能力。
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 lib/i18n/locales/zh-CN.json | 8 ++++----
 1 file changed, 4 insertions(+), 4 deletions(-)

commit 233606f7e3ec6814c77c8b84869a038bb3ad0ac0
Author: laixue-bot <laixue-bot@local>
Date:   Thu Jul 23 17:24:04 2026 +0800

    docs: SQL 类型注释 — profiles.id / students.user_id 都是 uuid，不强转
    
    用户提醒：profiles.id、students.user_id、courses.created_by、
    course_assignments.student_id 都是 uuid 类型，auth.uid() 直接
    返回 uuid，policy 里直接比较即可，不需要 ::text 强转。
    
    加注释明确说明这一点，避免未来读这段 SQL 的人照着 RLS
    通用模板习惯加上 ::text 强转（那种写法在某些场景下会让
    UUID 格式校验失效，破坏 defense-in-depth）。
    
    审计结论：全代码库 grep `auth.uid()::` 零命中，所有现有
    SQL / TS 代码都正确使用了直接比较。
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 supabase-rls-tighten-courses-owner.sql | 9 +++++++++
 1 file changed, 9 insertions(+)

commit ecc21bb408e657fef46cba8ee906da62c592b602
Author: laixue-bot <laixue-bot@local>
Date:   Thu Jul 23 15:55:37 2026 +0800

    security: RLS 加固 + AI 生成接口防刷 + 分享页二次验证
    
    发现 4 个真实漏洞，全部已修：
    
    1. /api/courses/[id] GET 完全没有权限校验，任何登录用户
       猜测 ID 都能拿到任意课程的完整内容（包含 prompts / drafts
       / metadata）。修复：登录校验 + 角色 + 所有权/分配关系三层
       检查；learner 必须有 course_assignments 行指向自己的
       student user_id。
    
    2. /api/generate/* 9 个路由全部没有任何 auth——anon 都能直接
       触发 LLM / 图像 / 视频 / TTS 推理，会产生大量 token 费用。
       修复：新增 lib/server/api-guard.ts 提供 requireAuthOrTeacher()
       + rateLimitByUser() 两个工具，所有 9 个 generate 路由 +
       /api/generate-classroom 全部加上：
         - 登录校验（未登录 401）
         - 角色校验（仅 teacher/admin，learner 403）
         - 内存 Map 频率限制（按用户 ID，每个 bucket 独立计数）
         - 429 + Retry-After + X-RateLimit-* headers
    
    3. supabase-rls-tighten-courses-owner.sql：收紧
       course_assignments 的 SELECT 策略——learner 只能读自己
       被分配的，teacher/admin 可读全部。提供 dirty created_by
       行回填指引。
    
    4. lib/mobile/course-data.ts 直接用 service_role key——目前
       安全（RSC，无 'use client' import），但脆弱。加防御性注释
       警告未来调用方，并指向 /api/courses/[id] 作为更安全的
       入口。
    
    API_ERROR_CODES 新增 UNAUTHENTICATED / FORBIDDEN /
    PROFILE_LOOKUP_FAILED / SERVER_MISCONFIG 四个错误码。
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 app/api/courses/[id]/route.ts                   |  92 +++++++++-
 app/api/generate-classroom/route.ts             |   9 +
 app/api/generate/agent-profiles/route.ts        |   9 +
 app/api/generate/image/route.ts                 |  11 ++
 app/api/generate/scene-actions/route.ts         |  10 ++
 app/api/generate/scene-content/route.ts         |  10 ++
 app/api/generate/scene-outlines-stream/route.ts |   9 +
 app/api/generate/tts/route.ts                   |  10 ++
 app/api/generate/video/route.ts                 |  11 ++
 app/api/generate/voice/route.ts                 |  10 ++
 docs/SECURITY-CHECKLIST-2026-07-23.md           |  99 ++++++++++
 lib/mobile/course-data.ts                       |  18 ++
 lib/server/api-guard.ts                         | 229 ++++++++++++++++++++++++
 lib/server/api-response.ts                      |   7 +
 supabase-rls-tighten-courses-owner.sql          | 169 +++++++++++++++++
 15 files changed, 701 insertions(+), 2 deletions(-)

commit fb9a36b36d4cc84960e86d9fa4fa6aac3d87d996
Author: laixue-bot <laixue-bot@local>
Date:   Thu Jul 23 09:57:19 2026 +0800

    chore: 顺序问题收尾 — saveStageData 字段白名单补漏 + 左侧导航防御性注释
    
    任务 1（关键 bug 修复）：
    saveStageData 的 db.stages.put({...}) 字段白名单漏了
    sceneOrderTrusted / sceneOrderRepairedAt。setScenes / self-heal /
    ?repairOrder=createdAt 写入 trusted=true 后，debouncedSave →
    saveStageData 会丢回 trusted=undefined，导致下次 loadStageData
    又走 createdAt 修复路径，可能与手动调序冲突。
    
    修复：在白名单里加 sceneOrderTrusted + sceneOrderRepairedAt，
    通过 unknown 转型绕过 DSL Stage 类型的窄接口。
    
    任务 3（防御性注释）：
    - Pro Mode 左侧导航 SlideNavRail：明确"专业模式是允许拖拽
      调序的唯一地方"，禁止复制 Reorder 模式到其他组件。
    - Playback 左侧导航 SceneSidebar（view / share / 学习 / 打开）：
      明确禁止任何二次排序 / 拖拽，scenes 必须原样渲染。
    
    任务 2/4 验证结果（无需代码变更）：
    - 任务 2：所有 prefer='createdAt' 出现位置都有合理解释
      （v14 migration、?repairOrder 逃生口、cloud-sync 注释）。
      没有 hotfix / workaround / 止血残留。
    - 任务 4：draggable / Reorder.Group 只在 Pro Mode SlideNavRail
      出现，Playback SceneSidebar 干净，保留 Pro Mode 拖拽能力
      （产品决策：普通编辑模式不支持，专业模式支持）。
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 components/edit/SlideNavRail/SlideNavRail.tsx | 12 ++++++++++++
 components/stage/scene-sidebar.tsx            | 16 ++++++++++++++++
 lib/utils/stage-storage.ts                    | 12 ++++++++++++
 3 files changed, 40 insertions(+)

commit ecb8a70d87702c4ad4a5338587aa89ebb012c03d
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 20:22:27 2026 +0800

    refactor: 把 createdAt 改回一次性 repair 工具，seq 回归长期可信
    
    598ac5d0 把所有读取路径强制 prefer='createdAt'，可以止血坏数据，
    但 createdAt 不能代表用户编辑后的最终顺序（手动调序/插入/复制
    页面会被覆盖）。
    
    长期方案：stage 加 sceneOrderTrusted 标记，loadStageData 根据
    标记选 prefer 模式——trusted=true 信任 seq（正常路径），未 trusted
    走 createdAt 修复一次并设 trusted=true。后续手动调序写入路径都
    负责设 trusted=true，让用户手动操作永远胜出。
    
    变更：
    - db.version(15)：标记现有 stage 为 trusted=true（v14 已修复过），
      scenes 表 schema 不变。StageRecord 加 sceneOrderTrusted /
      sceneOrderRepairedAt 字段。
    - lib/utils/stage-storage.ts loadStageData：根据 trusted 选 prefer，
      未 trusted 时强制 prefer='createdAt' 修复 + bulkPut scenes +
      update stage 标记 trusted=true。
    - lib/utils/cloud-sync.ts collectStageData：根据 trusted 选 prefer，
      上传时不再无脑 force createdAt。
    - lib/utils/database.ts getScenesByStageId：回归 prefer='auto'（信任 seq）。
    - lib/utils/stage-storage.ts 缩略图生成：回归 prefer='auto'。
    - lib/store/stage.ts setScenes：写入时设 trusted=true（手动操作视为可信）。
    - app/classroom/[id]/page.tsx self-heal + ?repairOrder=createdAt：
      修复后设 trusted=true 并持久化。
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 app/classroom/[id]/page.tsx | 32 ++++++++++++++---
 lib/store/stage.ts          | 17 ++++++++++
 lib/utils/cloud-sync.ts     | 38 ++++++++++++---------
 lib/utils/database.ts       | 83 ++++++++++++++++++++++++++++++++++++++++++---
 lib/utils/stage-storage.ts  | 64 ++++++++++++++++++++++++++--------
 5 files changed, 195 insertions(+), 39 deletions(-)

commit 598ac5d0344302028df55ef2198b486e935ea60d
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 19:55:49 2026 +0800

    fix: 所有 IndexedDB 读 scene 路径强制 prefer='createdAt' — 不让中毒 seq 复活
    
    根因：2878bdd5 只修了 v14 migration 和 ?repairOrder=createdAt，
    但 loadStageData / collectStageData / getScenesByStageId / 缩略图生成
    仍在用默认 'auto' 模式。默认模式 Tier 1 优先 seq，而 seq 是中毒的。
    
    效果链条：
    1. 用户手动 ?repairOrder=createdAt → IndexedDB scenes 顺序修好
    2. 用户刷新页面 → loadStageData 用中毒 seq 重新"排序"
    3. 课程又乱回来了
    
    修复：所有读 scenes 的入口强制 prefer: 'createdAt'：
    - loadStageData（stage-storage.ts）— 影响所有 classroom 入口
    - collectStageData（cloud-sync.ts）— 影响 saveStageToCloud 上传
    - getScenesByStageId（database.ts）— 影响所有 getScenesByStageId 调用方
    - stage-storage.ts:323 缩略图生成 — 之前用 sortBy('seq')
    
    现在任何路径读取 IndexedDB scenes 都会先按 createdAt 重新恢复，
    中毒 seq 不再有机会污染后续展示。
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 lib/utils/cloud-sync.ts    |  6 +++++-
 lib/utils/database.ts      |  7 ++++++-
 lib/utils/stage-storage.ts | 14 ++++++++++++--
 3 files changed, 23 insertions(+), 4 deletions(-)

commit 2878bdd553ebd6cc957cb7d54755db8baa23d8c1
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 19:38:11 2026 +0800

    fix: orderSceneRecordsForDisplay 支持 prefer=createdAt，强制忽略中毒 seq
    
    根因：43611ac0 的 v14 migration 默认调用 orderSceneRecordsForDisplay，
    Tier 1 仍会优先使用 seq。但 v13 已经把坏 order 固化成"看起来合法"
    的 seq=0,1,2...，所以默认行为就是读取中毒数据 → 不修复。
    
    修复：
    
    一、orderSceneRecordsForDisplay 加 options.prefer
      - 'auto'（默认）：保持现有 seq → createdAt → updatedAt → id 行为
      - 'createdAt'：强制忽略 seq，按 createdAt → updatedAt → id 排序
      - 加 strictCreatedAtComparator 在 prefer='createdAt' 时使用
    
    二、v14 migration 强制 prefer: 'createdAt'
      - 不能再用默认 auto（会读到中毒 seq）
      - 每个 stage 无条件 delete + bulkPut，不再因 source='seq' 跳过写入
      - 增加 [v14 Migration] 日志：source / beforeCount / afterCount /
        first10Before / first10After
    
    三、?repairOrder=createdAt 也强制 prefer='createdAt'
      - 日志增加 repairSource 字段确认走的是 createdAt/updatedAt/id
      - 日志增加 first10Before / first10After 完整诊断
    
    四、importCourseFromCloud 注释修正
      - 原注释说可以 repair scrambled cloud JSON，不准确
      - 实际只能修复"cloud array 顺序对，但内部 seq/order 字段坏"
      - cloud array 本身错序必须用 ?repairOrder=createdAt 或服务端脚本
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 app/classroom/[id]/page.tsx | 24 +++++++++++----
 lib/utils/cloud-sync.ts     | 11 ++++---
 lib/utils/database.ts       | 60 ++++++++++++++++++++++++++++++++-----
 lib/utils/scene-order.ts    | 72 ++++++++++++++++++++++++++++++++++++++-------
 4 files changed, 138 insertions(+), 29 deletions(-)

commit 43611ac051af17587c1d668b4c9534c419b394d6
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 19:32:45 2026 +0800

    fix: schema v14 重新恢复 seq + repairOrder=createdAt 临时入口
    
    按 GPT-5.5 紧急修复建议实施：
    
    一、orderSceneRecordsForDisplay 工具函数
    新增 lib/utils/scene-order.ts 统一工具：
    - 多级 fallback 排序：seq → createdAt → updatedAt → id
    - legacy order 字段**不再参与**恢复逻辑（已证明不可信）
    - 按 id 去重，输出去重后的列表
    - 输出时 normalize seq=order=array index
    
    二、schema 升级到 v14 + 修复性 migration
    v13 migration 用 legacy order 给旧数据生成 seq，已被证明把坏顺序固化。
    v14 migration 用 orderSceneRecordsForDisplay 重新恢复：
    - 按 createdAt/updatedAt/id 排序
    - 去重（重复 id 的场景会被丢弃）
    - 重新赋 seq=order=index
    
    三、所有读取路径改用 orderSceneRecordsForDisplay
    - loadStageData：toArray + 信任工具函数
    - collectStageData：同上
    - importCourseFromCloud：先 delete 本地再 bulkPut + 强制 seq/order=array index
    
    四、saveStageData 去重
    保存前按 scene.id 去重，避免重复页面。
    
    五、page.tsx 新增 ?repairOrder=createdAt 临时修复入口
    当 self-heal 不触发（seq 已对齐但 array 顺序仍是坏）时，
    用户访问 /classroom/:id?editor=1&repairOrder=createdAt 可强制重排。
    打印 [ORDER REPAIR][Before]/[After] 对比日志，写回 IndexedDB + cloud。
    
    六、诊断日志
    [loadStageData] / [saveStageData] / [collectStageData] / [importCourseFromCloud]
    统一记录 sceneCount + first5(scene id/title/order/seq/createdAt) + orderingSource + source
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 app/classroom/[id]/page.tsx |  63 ++++++++++++++++++++++-
 lib/utils/cloud-sync.ts     |  68 ++++++++++++++++++------
 lib/utils/database.ts       |  59 ++++++++++++++++++++-
 lib/utils/scene-order.ts    | 123 ++++++++++++++++++++++++++++++++++++++++++++
 lib/utils/stage-storage.ts  | 101 ++++++++++++++++++++++++++----------
 5 files changed, 369 insertions(+), 45 deletions(-)

commit 4d1dbb3a7beba40fbb9409c1a1b44679164e3b10
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 19:04:33 2026 +0800

    fix: collectStageData 用 sortBy('seq') — 修复上传到云端时 scenes 数组被 nanoid 字典序打乱
    
    根因：
    - lib/utils/cloud-sync.ts:25 的 collectStageData() 用 db.scenes.where(...).toArray()
    - 没有 sortBy，导致从 IndexedDB 读出 scenes 后按 primary key (id, nanoid) 字典序
    - 上传到 cloud course 的 scenes 数组顺序因此被 nanoid 字典序决定
    - 学员 share=1 访问 → server 返回 cloud data → 看到 nanoid 字典序的乱序页面
    
    之前 share "没坏" 是因为 nanoid 字典序恰好接近生成顺序；用户测试的另一门课
    的 nanoid 序列与生成顺序不一致，所以看到完全乱序 + 重复（id 重复导致）。
    
    修复：
    - collectStageData() 改用 sortBy('seq')，从 IndexedDB 读出时按真实插入顺序
    
    注意：
    - 这是数据流修复，不修复已有的坏 cloud data
    - 用户需要重新保存一次课程到云端，让 cloud data 用正确的 seq 顺序覆盖
    - saveStageData / loadStageData / getFirstSlideByStages / getScenesByStageId
      / importCourseFromCloud 都已用 sortBy('seq') 或 seq=index 修复
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 lib/utils/cloud-sync.ts | 7 ++++++-
 1 file changed, 6 insertions(+), 1 deletion(-)

commit 7fe96285fadc6b594b6c326ad924889b269401e3
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 18:53:16 2026 +0800

    refactor: 教师端首页最小可用重构 — 解决"两个我的课程"和按钮文案混乱
    
    问题：
    - 顶部缩略图区 zh-CN 把 classroom.recentClassrooms 翻译成"我的课程"
    - CloudCourses 组件里又有"📚 我的课程"section
    - → 教师在同一页面看到两个"我的课程"，分不清"我可编辑的"和"我只是看过的"
    - 按钮"打开"在两种语境内含义不一致（自己的课程打开 = 编辑；他人的打开 = 预览）
    
    本轮只做最小可用改动（不动权限模型 / 搜索 / 协作）：
    
    1. 顶部缩略图区标题 zh-CN: 我的课程 → 最近浏览
    2. CloudCourses 组件：
       - "📚 我的课程" → "📚 我的创作"（+ 副标题"你创建或可以编辑的课程"）
       - "🌐 云端课程（发现）" → "🌐 课程资源库"（+ 副标题"发现可预览或复用的公开课程"）
    3. 按钮文案：
       - "打开" → "预览"（我的创作 / 课程资源库一致）
       - "✎ 编辑" → "✎ 继续编辑"
       - "分享" → "分享学员链接"（我的创作）/ "分享课程"（课程资源库）
    4. 轻量标签：课程卡片右上角加角标
       - 我的创作区："我的创作"（紫色调）
       - 课程资源库区："资源库"（灰色调）
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 components/cloud-courses.tsx | 48 ++++++++++++++++++++++++++++++++++----------
 lib/i18n/locales/zh-CN.json  |  2 +-
 2 files changed, 38 insertions(+), 12 deletions(-)

commit aa3d6cdc9ce48a3928f860f933495c4e5b1f77c0
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 18:47:42 2026 +0800

    fix: 引入 seq 字段作为可信展示顺序 — 彻底解决 view 页乱序
    
    根因（view=1 才坏，share/editor 不坏的解释）：
    - share=1：学员账号本地 IndexedDB 无数据 → 走 cloud course fetch → server 返回数组顺序 → 正常
    - editor=1：管理员编辑时触发 rebalance / save → IndexedDB 更新 → 正常
    - view=1：管理员预览 → loadStageData() → db.scenes.sortBy('order') →
      如果历史数据的 order 字段错乱（cloud 导入、pre-rebalance 写入、duplicate value），
      返回的 scenes 数组顺序就乱了
    
    之前修了几轮都没修到根：只调整了 in-memory 选择初始 scene 的逻辑，但
    scenes 数组本身就被 sortBy('order') 排错了，UI 渲染的 scenes 就是错乱的。
    
    最终方案：新增 monotonic 字段 `seq`
    - saveStageData 每次写 seq = array index（永远跟随真实数组顺序）
    - loadStageData 用 sortBy('seq') 取代 sortBy('order')
    - schema 升级到 v13：加 [stageId+seq] 复合索引
    - v13 migration：给现有 records 按当前 sortBy('order') 顺序赋 seq（保证确定性）
    - loadStageData 防御层：sortBy('seq') 后再次 normalize seq=index（处理 undefined/异常）
    - page.tsx 自检：load 后检测 seq !== i → 修复并 saveStageData 持久化
    
    新增 seq：
    - lib/types/stage.ts — AppScene.seq?: number
    - lib/utils/database.ts — SceneRecord.seq: number, schema v13, [stageId+seq] index
    - lib/utils/stage-storage.ts — save 写 seq，load sortBy('seq') + 防御 normalize
    - lib/utils/cloud-sync.ts — 上传/下载场景补齐 seq
    - lib/import/use-import-classroom.ts — 导入场景写 seq
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 app/classroom/[id]/page.tsx        | 50 ++++++++++++++++++++++++++++++
 lib/import/use-import-classroom.ts |  1 +
 lib/types/stage.ts                 |  6 ++++
 lib/utils/cloud-sync.ts            | 12 ++++++--
 lib/utils/database.ts              | 62 ++++++++++++++++++++++++++++++++++++--
 lib/utils/stage-storage.ts         | 28 ++++++++++++++---
 6 files changed, 149 insertions(+), 10 deletions(-)

commit 4fa0c64462beaf35e6cbacd1e93fbe50f0467bad
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 18:20:25 2026 +0800

    fix: 完全移除 order 排序 — 始终使用 rawScenes 原始数组顺序
    
    上一轮修复虽然加了 "order 完整且唯一才排序" 的保护，但发现：
    - 部分历史课程的 order 字段完整且唯一，但与真实页序不一致
      （例如 order=2 指向 "开场" 而真实第1页在数组 index 0）
    - 因此 "安全排序" 仍然把课程顺序排乱
    
    最终决策：对于课堂学习/分享/打开入口，**完全不使用 order 字段做排序**。
    rawScenes 数组顺序（从 server/IndexedDB 来的原始顺序）就是真实的展示顺序。
    
    改动：
    - lib/utils/scene-order.ts 重构为诊断工具（inspectOrderField），
      不再提供排序函数
    - app/classroom/[id]/page.tsx 主重算块和 2 个 fallback 路径：
      displayScenes = rawScenes（直接用原始顺序）
    - lib/store/stage.ts setScenes() 取第一页也用 migrated[0]
    - [CLASSROOM INIT] 日志新增字段反映 "displayUsesRawArrayOrder: true"
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 app/classroom/[id]/page.tsx | 46 +++++++++++++--------
 lib/store/stage.ts          |  9 ++---
 lib/utils/scene-order.ts    | 97 +++++++++++++++++++--------------------------
 3 files changed, 75 insertions(+), 77 deletions(-)

commit dde9817fc6a2e4c29aacb4cb5f465ef170150d9d
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 18:10:07 2026 +0800

    fix: 移除无条件 order 排序 — 改为安全排序工具函数防止课程顺序被打乱
    
    问题：上一轮修复引入了 [...scenes].sort((a,b) => a.order - b.order)，
    但历史课程的 scene.order 可能不完整/不唯一/缺失/与真实顺序不一致，
    导致强制排序把课程页序打乱（第3页排到第1位）。
    
    修复：
    - 新增 getDisplayOrderedScenes() 工具函数（lib/utils/scene-order.ts）
      - 只有全部 scene 都有有效且唯一的 order 时才按 order 排序
      - 否则保留原始数组顺序（真实展示顺序）
    - 替换 classroom 页面 3 处排序调用（主重算块 + 2 个 fallback）
    - stage.ts setScenes() 只在"取第一页"时使用安全排序，
      不改变存入 store 的 scenes 数组本身
    - [CLASSROOM INIT] 日志新增排序诊断字段：
      rawSceneOrders / displaySceneOrders / orderSortApplied / orderSortSkippedReason
    
    改动文件：
    - lib/utils/scene-order.ts（新增）
    - app/classroom/[id]/page.tsx（3 处替换 + 日志增强）
    - lib/store/stage.ts（setScenes 安全排序）
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 app/classroom/[id]/page.tsx | 70 ++++++++++++++++++------------------------
 lib/store/stage.ts          | 17 +++++-----
 lib/utils/scene-order.ts    | 75 +++++++++++++++++++++++++++++++++++++++++++++
 3 files changed, 112 insertions(+), 50 deletions(-)

commit 28eb5193568393be47116a3b07efc719d96c0a4d
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 17:53:59 2026 +0800

    fix: 初始场景定位错误 — share/打开/学习入口强制从第一页开始
    
    根因：loadFromStorage() 从 IndexedDB 无条件恢复 stage.currentSceneId（上次编辑位置），
    导致分享链接/打开按钮/学员入口都 landing 到历史页而非第一页。
    
    修复：
    - loadFromStorage 后新增初始场景重算块，按优先级选择：
      1. URL 显式 ?sceneId（有效时使用）
      2. Editor 模式 + 有效 currentSceneId（恢复编辑位置）
      3. 其他入口 → sortedScenes[0]（强制第一页）
    - 所有 scenes 排序统一为稳定排序（缺失 order 时 fallback 到原数组 index）
    - 移动端 /m/[id] share 模式跳过 localStorage 进度恢复
    - 新增 [CLASSROOM INIT][Initial Scene] 诊断日志
    
    改动文件：
    - app/classroom/[id]/page.tsx — 主修复 + 日志
    - lib/store/stage.ts — setScenes() 排序保护
    - app/m/[id]/page.tsx — isShareMode 透传
    - app/m/[id]/_components/MobilePlayer.tsx — share 模式 chapterIndex=0
    
    Co-Authored-By: Claude <noreply@anthropic.com>

 app/classroom/[id]/page.tsx             | 111 +++++++++++++++++++++++++++++++-
 app/m/[id]/_components/MobilePlayer.tsx |  14 +++-
 app/m/[id]/page.tsx                     |   6 +-
 lib/store/stage.ts                      |  12 +++-
 4 files changed, 137 insertions(+), 6 deletions(-)

commit 3473b7f987688392c77e22cb51e51ff8c8fa3f38
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 17:06:24 2026 +0800

    chore: 添加微信站长认证验证文件

 public/026df3f2d3d589c1fc2be85ec676794e.txt | 1 +
 1 file changed, 1 insertion(+)

commit 4b4fbd1ecaf8da557669e1fffd73ca850057b607
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 17:02:51 2026 +0800

    refactor(mobile): 切换为 audioSegments 连续播放方案（替代 Uint8Array concat）
    
    背景：ec347d0b 的 Uint8Array 直接拼接 MP3 帧未经验证（Chrome/iOS/
    duration/seek），不能上线。改为复用已有的 speechAction.audioUrl
    分段音频，移动端顺序自动播放。
    
    发布端（audio-publish.ts）变更：
    - 移除 generateChunkedTTSForText() 及 NARRATION_TTS_CHUNK_SIZE 常量
    - 移除 splitLongSpeechText import
    - narrationAudioUrl 生成改为 best-effort：
      - 文本 ≤500 字 → 尝试直接 TTS 生成
      - 文本 >500 字 → 跳过，日志说明走 audioSegments 路径
      - 失败 → console.warn，不进 failed[]，不阻塞保存
      - validatePublishedAudioAssets() 只检查 speechAction.audioUrl
    
    数据层（scene-helpers.ts）变更：
    - 新增 MobileAudioSegment 接口（id/audioUrl/audioId/text/order/sourceField）
    - MobileChapter 新增 audioSegments: MobileAudioSegment[] 字段
    - 新增 extractAudioSegments() 函数：
      - narrationAudioUrl 存在 → 单个整章 segment
      - 否则 → 每个 speech action 有 audioUrl 的生成一个 segment
    - extractAudio() 改为从 segments[0] 取值（保持兼容）
    - buildChapters() 透传 audioSegments
    
    播放器（AudioPlayer.tsx）重构：
    - 新增 audioSegments prop + currentSegmentIndex state
    - hasUserInteractedRef 追踪用户是否点击过播放
    - 首次加载不 autoplay（避免 NotAllowedError）
    - 用户点击 ▶ 后设置 hasUserInteracted = true
    - 当前段 ended → 自动切换下一段（同一次播放流程）
    - 最后一段 ended → 调用 onEnded() 进入下一章
    - 切换章节时 key 变化触发 remount + segmentIndex 重置 0
    - 总段数 >1 时显示 "片段 N/M" 指示器
    - NotAllowedError 显示 "请点击播放按钮继续收听"（非硬错误）
    - 真实 audio error 才显示 "音频加载失败"
    
    MobilePlayer.tsx：
    - 透传 current.audioSegments 给 AudioPlayer
    
    新增诊断日志：
      [MOBILE AUDIO][Segment Ended]   — 含 segmentIndex/segmentCount/hasNext
      [MOBILE AUDIO][Segment Switch]  —含 from/to index/autoContinue
      [MOBILE AUDIO][Chapter Ended]    — 含 segmentCount
      [MOBILE LEARN][Audio Source]     — 增加 audioSegmentCount/currentSegmentIndex

 app/m/[id]/_components/AudioPlayer.tsx  | 182 +++++++++++++--------
 app/m/[id]/_components/MobilePlayer.tsx |   1 +
 lib/audio/audio-publish.ts              | 269 +++++++++++---------------------
 lib/mobile/scene-helpers.ts             |  97 ++++++++++--
 4 files changed, 287 insertions(+), 262 deletions(-)

commit ec347d0befa6f8064d7ace519b081d7d948e46f9
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 16:49:01 2026 +0800

    fix(mobile): 整章旁白 TTS 改为分块生成（修复"TTS 返回数据缺失"导致保存失败）
    
    问题：
    - 整章合并文字（1000-3000+ 字）超过 MiniMax TTS 单次调用限制
    - generateTTSForText() 调用后返回 !json.data.base64 → "TTS 返回数据缺失"
    - 所有课程的 narration 音频全部生成失败 → 保存到云端被 validate 阻止
    
    修复：
    - 新增 generateChunkedTTSForText() 函数：
      - 文本 ≤ 500 字 → 直接调 generateTTSForText（无分块开销）
      - 文本 > 500 字 → 用项目已有 splitLongSpeechText() 按句号/逗号分块
      - 每块独立调用 TTS API（chunkAudioId = baseId_c1, _c2, ...）
      - 所有 Uint8Array 拼接为一个完整 ArrayBuffer
      - 任一块失败立即抛错，不返回残缺音频
    - 整章音频生成从 generateTTSForText 切换为 generateChunkedTTSForText
    - 常量 NARRATION_TTS_CHUNK_SIZE = 500（MiniMax 保守上限）
    
    新增日志：
      [TTS CHUNK][Narration Start]   — 总字数/分块数
      [TTS CHUNK][Narration Progress] — 每块进度（第 N/M 块，字数，音频大小）
      [TTS CHUNK][Narration Done]    — 总音频字节/format

 lib/audio/audio-publish.ts | 92 +++++++++++++++++++++++++++++++++++++++++++++-
 1 file changed, 91 insertions(+), 1 deletion(-)

commit e4f717e89f53ccb0fb6c785c204cd2eb8b4b762c
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 16:18:56 2026 +0800

    refactor(mobile): 整章音频改用 scene 级 narrationAudioUrl 字段（不污染 speechAction.audioUrl）
    
    架构改进：
    - 新增 scene 级字段：narrationAudioUrl / narrationAudioId / narrationAudioTextHash
    - speechAction.audioUrl 保持单段语义，不被整章音频覆盖
    - PC 端逐段播放、编辑器试听、单段重生成都不受影响
    
    发布逻辑（audio-publish.ts）：
    - 每个 scene 处理完后，提取所有 speech.text → \n\n 拼接为 fullText
    - 用 stableHash(fullText + teacherVoiceConfig) 生成 textHash
    - hash 匹配且 URL 存在 → 跳过重新生成 [TTS SKIP]
    - hash 不匹配或无 URL → 生成整章 TTS → 上传 → 写入 scene 级字段
    - 生成失败不阻塞发布，记入 failed 列表
    
    移动端读取（scene-helpers.ts）：
    - extractAudio() 优先级：narrationAudioUrl > first SpeechAction.audioUrl
    - 返回 sourceField 用于日志区分数据来源
    - MobileChapter 接口新增 audioSourceField 字段
    
    诊断日志：
    - [TTS INPUT][Scene Narration Audio] — 含 textHash/shouldRegenerate
    - [TTS SKIP][Scene Narration Audio] — hash 命中跳过原因
    - [TTS OUTPUT][Scene Narration Audio] — 含 narrationAudioUrl/textHash
    - [MOBILE LEARN][Audio Source] audioSourceField 显示 Scene.narrationAudioUrl 或 fallback
    
    旧课程兼容：
    - 无 narrationAudioUrl 的旧课程 fallback 到 SpeechAction.audioUrl
    - 管理员重新"保存到云端"后自动生成 narrationAudioUrl

 app/m/[id]/_components/AudioPlayer.tsx  |   9 ++-
 app/m/[id]/_components/MobilePlayer.tsx |   1 +
 lib/audio/audio-publish.ts              | 113 +++++++++++++++++++++-----------
 lib/mobile/scene-helpers.ts             |  50 ++++++++++----
 4 files changed, 119 insertions(+), 54 deletions(-)

commit 2c4e7db847077ecb3f8726122a99d8abca714c0d
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 16:08:13 2026 +0800

    fix(mobile): 发布时为每章生成完整合并音频（修复只播第一段问题）
    
    根因（两层配合出错）：
    
    1. audio-publish.ts 发布循环按 speech action 逐个生成音频，
       每个音频只包含该段文字（~9秒/段）
    2. scene-helpers.ts extractAudio() 只取第一个 speech action
       的 audioUrl → 移动端只能拿到第一章的短音频
    
    而移动端正文展示 extractNarrationText() 是合并所有 speech text
    的 → 音频和正文不一致。
    
    修复：在 publishSceneAudioAssets() 处理完每个 scene 所有 speech
    action 后，新增"合并音频"步骤：
    - 如果 scene 有 >1 个 speech action
    - 提取所有 speech.text 并用 \n\n 连接
    - 调用 TTS 生成一个完整章节音频
    - 覆盖第一个 speech action 的 audioUrl（移动端读取点）
    - 单 speech action 的 scene 不受影响（本身就是完整的）
    
    新增函数：extractFullNarrationText() — 合并所有 speech 文本
    
    诊断日志：
      [TTS INPUT][Scene Audio] — 含 speechActionCount/fullTextLength/
        fullTextPreview/sourceField（区分 individual vs combined）
      [TTS OUTPUT][Scene Audio] — 含 audioUrl/inputTextLength/
        source（区分 individual vs combined）
    
    旧课程处理：
      需要管理员重新"保存到云端"触发 publishSceneAudioAssets()
      才会重新生成合并音频。旧 audioUrl 不会自动更新。

 lib/audio/audio-publish.ts | 116 ++++++++++++++++++++++++++++++++++++++++++++-
 1 file changed, 115 insertions(+), 1 deletion(-)

commit 5497362c22a52b1c3d61bfc973d34993d000af81
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 15:37:17 2026 +0800

    diag(mobile): 移动端音频播放器完整诊断日志
    
    在 AudioPlayer.tsx 的 <audio> 元素上增加 9 个事件监听和
    3 个 play() 调用点日志，用于定位"audioUrl 存在但只播开头"问题：
    
    事件日志：
      [MOBILE AUDIO][loadstart]     — 音频开始加载
      [MOBILE AUDIO][loadedmetadata] — 含 duration（关键：确认文件是否被截断）
      [MOBILE AUDIO][canplay]        — 可播放
      [MOBILE AUDIO][playing]        — 正在播放
      [MOBILE AUDIO][pause]          — 暂停
      [MOBILE AUDIO][ended]          — 播放结束
      [MOBILE AUDIO][error]          — 含 errorCode/errorMessage
    
    play() 调用点日志（每个都含 readyState/networkState）：
      [MOBILE AUDIO][Before Play]    — loadedmetadata 自动播放前
      [MOBILE AUDIO][Play Success]   — 自动/手动播放成功
      [MOBILE AUDIO][Play Failed]    — 失败（含 errorName/errorMessage）
      [MOBILE AUDIO][Before Play (user click)] — 用户点击播放按钮
      [MOBILE AUDIO][Play Success/Failed (user click)]
    
    关键诊断字段：
      - duration: 确认音频文件本身是否被 MiniMax 截断
      - errorName: 是否 NotAllowedError（自动播放拦截）
      - errorCode: 是否 MEDIA_ERR_SRC_NOT_SUPPORTED 等

 app/m/[id]/_components/AudioPlayer.tsx | 148 +++++++++++++++++++++++++++++----
 1 file changed, 134 insertions(+), 14 deletions(-)

commit 41832fefcd56b7f798be42a6535b9962841c3adc
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 15:22:12 2026 +0800

    fix: 移除 StudentGate 访问码弹门（已被 Supabase Auth 账号体系替代）
    
    StudentGate（6位访问码输入框）是上游 OPENMAIC 的遗留机制，
    被 Supabase Auth 账号登录替代后变成了死代码。
    
    之前不出现是因为 cloud-courses.tsx 分享链接缺 ?share=1
    导致 readOnlyShare 永远为 false，StudentGate 从未触发。
    commit 7d732314 修复分享链接带 ?share=1 后，这个死代码
    被激活了——已登录用户打开分享链接时弹出访问码弹窗。
    
    移除内容：
    - StudentGate import
    - showGate state + setShowGate useEffect
    - JSX 中的 <StudentGate /> 渲染分支
    
    保留 verifiedStudentId/learning event 逻辑不变（无副作用，
    verifiedStudentId 为 null 时事件不会触发）。

 app/classroom/[id]/page.tsx | 17 -----------------
 1 file changed, 17 deletions(-)

commit 7d732314bdde920865396f01251a0f82bfe1d7e4
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 14:59:45 2026 +0800

    fix(mobile): 分享链接场景下管理员/教师也跳转移动端 + 分享链接补 ?share=1
    
    跳转条件改为：
      editor 模式 → 不跳（优先级最高）
      管理员/教师 且 非分享模式 → 不跳（管理入口保护）
      其余（学员 / 任何人通过分享链接）→ 手机端跳 /m/
    
    同时修复 cloud-courses.tsx handleShare 生成的分享链接
    缺少 ?share=1 参数，导致移动端无法识别为分享入口。
    learning-manager.tsx 已正确带 ?share=1（无需修改）。
    
    新增 [MOBILE REDIRECT][Classroom] 日志（含 id/isMobile/
    isEditorMode/isShareMode/isAdminOrTeacher/target，不含敏感信息）。

 app/classroom/[id]/page.tsx  | 40 +++++++++++++++++++++++++++-------------
 components/cloud-courses.tsx |  2 +-
 2 files changed, 28 insertions(+), 14 deletions(-)

commit 8915abec08f88099ab35f2c10784fc3b7e7e31f9
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 14:37:45 2026 +0800

    fix(mobile): 管理员/教师页面不触发移动端自动跳转 /m
    
    问题：classroom 页面的移动端检测只排除了 ?editor=1，未排除
    admin/teacher 角色。管理员在非编辑模式下打开课程（预览/
    查看），浏览器变窄或 DevTools 切手机模式时被错误跳转到
    /m/[id] 导致 404。
    
    修复：跳转条件增加 profile?.role === 'admin' || 'teacher' 排除，
    管理员/教师无论屏幕宽度如何都停留在桌面端。

 app/classroom/[id]/page.tsx | 20 +++++++++++++-------
 1 file changed, 13 insertions(+), 7 deletions(-)

commit 16629b5ab4981009083e8e94f2d5e175c6a844d2
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 14:18:25 2026 +0800

    fix(mobile): 补齐发布链路/播放路径/校验的缺失日志标签
    
    - AudioPlayer: 补 [MOBILE LEARN][Audio Source] 日志
    - audio-publish: 补 [MOBILE PUBLISH] 系列日志（TTS Resolve/Audio Blob Missing/Audio Uploaded/Validation Failed）
    - cloud-sync: 补 [CLOUD SYNC][Publish Audio Start/Done] 日志

 app/m/[id]/_components/AudioPlayer.tsx |  6 ++++++
 lib/audio/audio-publish.ts             | 36 ++++++++++++++++++++++++++++++++++
 lib/utils/cloud-sync.ts                |  9 +++++++++
 3 files changed, 51 insertions(+)

commit 71c0c0ff8318f5d510e45f820071c289a2e65295
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 14:06:50 2026 +0800

    fix(mobile): 发布时 Tier 3 TTS 优先使用 stage.teacherVoiceConfig
    
    - resolveTtsConfigForPublish() 新增 teacherVoiceConfig 参数
    - 优先级: stage.teacherVoiceConfig > settings store > provider-default
    - settings 只提供 apiKey/baseUrl（凭据），不覆盖音色选择
    - 新增 [MOBILE PUBLISH][TTS Voice Resolve] 日志（不含 apiKey）
    - saveStageToCloud() 从 stage 提取 teacherVoiceConfig 传给 publishSceneAudioAssets
    - AudioPlayer 去掉实时 TTS fallback，无 audioUrl 时显示明确错误提示
    - MobilePlayer/page.tsx 清理废弃的 teacherVoiceConfig prop 传递
    
    Co-Authored-By: WorkBuddy <workbuddy@codebuddy.cn>

 app/m/[id]/_components/AudioPlayer.tsx  | 401 ++++-------------------------
 app/m/[id]/_components/MobilePlayer.tsx |   9 -
 app/m/[id]/page.tsx                     |   1 -
 docs/AI-TEACHER-VOICE.md                |  41 +++
 docs/RELEASE-NOTES-2026-07-21.md        |  71 +++++
 lib/audio/audio-publish.ts              | 441 +++++++++++++++++++++++++++++++-
 lib/utils/cloud-sync.ts                 |  55 +++-
 7 files changed, 637 insertions(+), 382 deletions(-)

commit 528251d9ffeaa6d8a14d7c6c5230607d9ca41410
Author: laixue-bot <laixue-bot@local>
Date:   Wed Jul 22 11:46:29 2026 +0800

    feat(mobile): 移动端播客式学习页第一阶段
    
    - 新增 use-mobile-detection hook（UA + viewport 双条件检测）
    - 桌面端 /classroom/[id] 播放模式自动跳转移动端 /m/[id]（编辑模式不受影响）
    - scene-helpers 过滤交互章节（quiz/interactive/pbl），含 [MOBILE LEARN][Scene Filter] 日志
    - AudioPlayer 重写：5 种 errorType 分类、分段 TTS 请求+拼接（解决 MiniMax API 静默截断）、teacherVoiceConfig 兜底音色、[MOBILE LEARN][Audio Source] 日志
    - TextScript 字号 17px + pb-safe 适配 iPhone 底部安全区
    - course-data 提取 teacherVoiceConfig 传递给播放器
    - globals.css 新增 pb-safe 工具类
    
    Co-Authored-By: WorkBuddy <workbuddy@codebuddy.cn>

 app/classroom/[id]/page.tsx             |  24 ++
 app/globals.css                         |   6 +
 app/m/[id]/_components/AudioPlayer.tsx  | 469 ++++++++++++++++++++++++++------
 app/m/[id]/_components/MobilePlayer.tsx |  36 ++-
 app/m/[id]/_components/TextScript.tsx   |  11 +-
 app/m/[id]/page.tsx                     |   1 +
 lib/hooks/use-mobile-detection.ts       |  73 +++++
 lib/mobile/course-data.ts               |  16 ++
 lib/mobile/scene-helpers.ts             |  89 +++++-
 9 files changed, 621 insertions(+), 104 deletions(-)

commit 746b150c361c8ab3908d2e1422cabc99994c8e6e
Author: laixue-bot <laixue-bot@local>
Date:   Tue Jul 21 16:59:50 2026 +0800

    chore(debug): log stage.teacherVoiceConfig on playback mount to diagnose prod
    
    Adds [Stage TeacherVoiceConfig Loaded] log line at PlaybackChromeRoot
    mount so we can see whether the runtime-extended field actually
    persisted through IndexedDB / classroom JSON in production builds.

 components/edit/PlaybackChromeRoot.tsx | 7 +++++++
 1 file changed, 7 insertions(+)

commit 6cf27df9df1189d73d80ed30433730e9524967cc
Author: laixue-bot <laixue-bot@local>
Date:   Tue Jul 21 16:25:10 2026 +0800

    fix(audio): persist teacher voice at course creation and apply to Q&A path
    
    - Add stage.teacherVoiceConfig captured at course-creation time
    - Inject teacherVoiceConfig into teacher agent in useDiscussionTTS hook entry
    - Simplify PlaybackChromeRoot teacherVoiceConfigForDiscussion to read stage directly
    - Add fallback chain for modelId (settings.ttsProvidersConfig -> TTS_PROVIDERS.defaultModelId)
    - Document AI-teacher voice policy in docs/AI-TEACHER-VOICE.md
    - Verify: Q&A TTS now uses English_Graceful_Lady per user design pick

 app/generation-preview/page.tsx        |  24 ++
 components/edit/PlaybackChromeRoot.tsx |  53 ++-
 docs/AI-TEACHER-VOICE.md               | 655 +++++++++++++++++++++++++++++++++
 lib/hooks/use-discussion-tts.ts        |  86 ++++-
 lib/teacher/apply-teacher-voice.ts     |  58 +++
 5 files changed, 860 insertions(+), 16 deletions(-)

commit 6ae715ddfbf7ac27a013356678cad3cf7200bfdb
Author: laixue-bot <laixue-bot@local>
Date:   Tue Jul 21 12:34:55 2026 +0800

    feat(docs): refresh product-intro.html with Feishu Miaoda design
    
    Replace the old product-intro.html with a Tailwind-styled page
    matching the Feishu Miaoda v2 design. Includes:
    - Sticky header with section navigation
    - Hero with title + testing account card (kept public per user request)
    - Intro section with 3 features + 2 screenshots (laixue-01, 02)
    - Audience section (3 persona cards)
    - HowTo section with 4 tabs (login / create / admin / learn)
      and 11 screenshots (laixue-03 through laixue-13)
    - FAQ section (3 collapsible items)
    - Contact section with email + 2nd CTA
    
    Replaces React + framer-motion stack from Miaoda export with
    self-contained vanilla HTML + Tailwind Play CDN. No build step,
    no React runtime, anonymous access on laixue.work for WeChat group
    sharing.
    
    13 PNG screenshots copied to public/docs/images/.

 public/docs/images/laixue-01.png | Bin 0 -> 742772 bytes
 public/docs/images/laixue-02.png | Bin 0 -> 299549 bytes
 public/docs/images/laixue-03.png | Bin 0 -> 19475 bytes
 public/docs/images/laixue-04.png | Bin 0 -> 140797 bytes
 public/docs/images/laixue-05.png | Bin 0 -> 50635 bytes
 public/docs/images/laixue-06.png | Bin 0 -> 29915 bytes
 public/docs/images/laixue-07.png | Bin 0 -> 26401 bytes
 public/docs/images/laixue-08.png | Bin 0 -> 60010 bytes
 public/docs/images/laixue-09.png | Bin 0 -> 54915 bytes
 public/docs/images/laixue-10.png | Bin 0 -> 19461 bytes
 public/docs/images/laixue-11.png | Bin 0 -> 32634 bytes
 public/docs/images/laixue-12.png | Bin 0 -> 48990 bytes
 public/docs/images/laixue-13.png | Bin 0 -> 44912 bytes
 public/docs/product-intro.html   | 810 ++++++++++++++++++++++++---------------
 14 files changed, 498 insertions(+), 312 deletions(-)

commit 22bab0b9a36a47476ea8594fd91d4d1c64d4c340
Author: laixue-bot <laixue-bot@local>
Date:   Mon Jul 20 20:07:25 2026 +0800

    fix(types): drop request.messages and msg.content reads; coerce through unknown
    
    The Q&A fix tried to fall back to request.messages when getMessages yielded
    an empty array, but AgentLoopRequest has no such field — TypeScript caught
    this at build time on Vercel.
    
    Two adjustments:
    - lib/chat/agent-loop.ts: keep messagesForRequest = currentMessages. The
      frontend getMessages callback already coalesces an empty list back to
      the caller-supplied template, so the loop layer doesn't need a second
      copy of the messages.
    - lib/orchestration/director-graph.ts and stateless-generate.ts: UIMessage
      (Vercel AI SDK v5) has no  field, only . Read text out
      of parts directly and route the dump loop through  casts so
      tsc is happy.

 lib/chat/agent-loop.ts                  |  5 +----
 lib/orchestration/director-graph.ts     | 21 +++++++++++++--------
 lib/orchestration/stateless-generate.ts |  2 +-
 3 files changed, 15 insertions(+), 13 deletions(-)

commit 91470671aea4308b99de4d74041e863375d905ba
Author: laixue-bot <laixue-bot@local>
Date:   Mon Jul 20 19:51:38 2026 +0800

    fix(qa): wire currentQAQuestion through state; stabilize client→server messages
    
    Root cause of repeated 'latest student question is missing (messages=0)' failures
    on the Q&A path: React state commit race in the client combined with an empty-array
    fallback that never triggered.
    
    Fixes:
    - components/chat/use-chat-sessions.ts: getMessages now falls back to the request
      template's messages whenever the live session ref returns an empty array, instead of
      relying on  which does not coalesce an empty list to the fallback.
    - lib/chat/agent-loop.ts: second-layer guard messagesForRequest picks the longer
      of getMessages() and request.messages before POSTing /api/chat.
    - lib/orchestration/director-graph.ts: register currentQAQuestion in the
      Annotation.Root with an explicit (prev, update) => prev ?? update reducer so the
      question survives LangGraph node-to-node channel updates. Director Stage 1
      now writes currentQAQuestion explicitly into state and Stage 2/3 dispatch the
      remaining peers/teacher closing turn.
    - lib/orchestration/stateless-generate.ts: extract student question from
      UIMessage.parts (Vercel AI SDK v5 has no  field); carry currentQAQuestion
      into the DONE directorState so peer/teacher closing turns on subsequent
      requests can find it without re-scanning messages.
    - lib/orchestration/prompt-builder.ts: build a dedicated Q&A teacher prompt
      that injects the latest student question as the last HumanMessage (no more
      generic 'It''s your turn to speak' cue).
    - lib/orchestration/summarizers/state-context.ts: produce plain-text slide
      summaries (no IDs / coordinates / numbering) to keep the LLM focused on the
      student's question during Q&A.
    - lib/types/chat.ts: add currentQAQuestion to DirectorState so it round-trips
      between server iterations.

 components/chat/use-chat-sessions.ts           |  14 +-
 lib/chat/agent-loop.ts                         |  13 +-
 lib/orchestration/director-graph.ts            | 330 +++++++++++++++++++++++--
 lib/orchestration/prompt-builder.ts            | 132 ++++++++--
 lib/orchestration/stateless-generate.ts        |  47 ++++
 lib/orchestration/summarizers/state-context.ts |  80 +++++-
 lib/types/chat.ts                              |   4 +
 7 files changed, 570 insertions(+), 50 deletions(-)

commit 75bc3897bd5075752168158a983873fa31dc90e3
Author: laixue-bot <laixue-bot@local>
Date:   Mon Jul 20 15:35:17 2026 +0800

    fix(qa): teacher closing round after peers + ban slide-narration openers
    
    - director-graph: after all peers speak in Q&A round, give teacher a closing turn
      before cue_user (fixes peer follow-up questions going unanswered)
    - prompt-builder: ban "好的，这页讲的是…" style slide-narration openers in Q&A mode
      (add to rule #1 BANNED openers list)

 lib/orchestration/director-graph.ts | 30 ++++++++++++++++++++++++------
 lib/orchestration/prompt-builder.ts |  2 +-
 2 files changed, 25 insertions(+), 7 deletions(-)

commit 39d54b076643f9b205f6432dd2145be69034f612
Author: laixue-bot <laixue-bot@local>
Date:   Mon Jul 20 15:09:35 2026 +0800

    fix(qa): multi-peer roundtable + suppress 'Your turn' cue + voice chain + prompt tuning
    
    - director-graph: all peers speak in Q&A round (not just one), strict sessionType validation
    - PlaybackChromeRoot: suppress isCueUser ("轮到你发言了" prompt) in Q&A mode — student types freely
    - use-chat-sessions: force sessionType='qa' when typing during lecture
    - use-discussion-tts: teacher voice 4-level priority chain (override → voiceConfig → global → fallback)
    - prompt-builder: rule #7 for vague questions ("这是什么"/"我不懂"), soften mandatory handoff
    - audio-upload: auto-create storage bucket via ensureAudioBucket()

 app/api/audio-upload/route.ts          |  33 +++++++++++
 components/chat/use-chat-sessions.ts   |   8 ++-
 components/edit/PlaybackChromeRoot.tsx |   6 +-
 lib/hooks/use-discussion-tts.ts        |  60 ++++++++++++++++---
 lib/orchestration/director-graph.ts    | 102 ++++++++++++++++-----------------
 lib/orchestration/prompt-builder.ts    |   5 +-
 6 files changed, 147 insertions(+), 67 deletions(-)

commit a2bd7e3df067bc96d0f07f1b05544d1572ef3600
Author: laixue-bot <laixue-bot@local>
Date:   Sun Jul 19 09:36:11 2026 +0800

    feat(qa): let a peer chime in after the teacher answers, then hand off
    
    Previously Q&A dispatched ONLY the teacher and cue_user fired the moment
    the teacher finished, so peers (role 'student') never appeared in Q&A —
    they only showed up in discussion mode. The user wants the classroom to
    feel alive: after the teacher answers, one classmate reacts, then the
    lesson continues.
    
    Two-stage Q&A round, driven by the existing client agent-loop (which
    re-issues requests with the accumulated directorState.agentResponses
    until it sees cue_user — no client change needed):
    
    director-graph.ts:
    - Q&A branch: stage 1 dispatches the teacher (role 'teacher'); stage 2
      dispatches exactly ONE peer (role 'student') if one exists and hasn't
      spoken for this question, then ends. Single-teacher courses have no
      peer, so the round collapses to teacher-only (unchanged behavior).
    - agentGenerateNode: cue_user now fires only after the FINAL speaker of
      the round (teacher spoken AND no peer pending), instead of on every
      agent turn — so the client loop survives past the teacher and the peer
      actually gets dispatched.
    - runAgentGeneration: inject the teacher's just-delivered answer (from
      agentResponses.contentPreview) into the peer's message history, so the
      peer reacts to what was actually said instead of producing filler.
    
    prompt-builder.ts:
    - new buildPeerQASystemPrompt: a self-contained 'react as a classmate'
      prompt (1-2 sentences, resonate OR one follow-up question, never
      re-answer, no slide narration). Peers short-circuit to this in Q&A mode
      so they don't inherit the teacher's 'answer completely' instructions.
    - QA_MODE_CLOSING: after the complete answer, the teacher now ends with
      ONE short transition sentence ('没问题的话,我们接着往下看。') — a
      handoff, not new teaching. This delivers the 'answer then continue'
      feel the user asked for instead of the session freezing on cue_user.
    
    Each new question starts a fresh directorState (client resets it per
    sendMessage), so agentResponses is empty at stage 1 of every question —
    the teacher re-answers each new question.

 lib/orchestration/director-graph.ts | 135 ++++++++++++++++++++++++++++++------
 lib/orchestration/prompt-builder.ts |  39 ++++++++++-
 2 files changed, 152 insertions(+), 22 deletions(-)

commit c552ffee76c7739d19b849901667fd35eb7285b1
Author: laixue-bot <laixue-bot@local>
Date:   Sat Jul 18 23:36:04 2026 +0800

    fix(qa): sandwich Q&A prompt and de-prime lecture cues
    
    Two remaining failures after 077d92b, both prompt-layer:
    
    1. First Q&A turn still opened with spotlight + slide narration. The
       template body is packed with lecture-priming content the preamble
       had to fight: spotlight-first FORMAT_EXAMPLE, SPOTLIGHT_EXAMPLES
       few-shot, slide action guidelines, and a final line that reads
       'Speak naturally as a teacher' (recency slot). On turn 1 the
       lecture cues won; only a repeated user question overcame them.
    
    2. Answers stopped mid-thought after ~130 chars. The teacher role
       guideline caps speech at ~100 characters for lecture pacing; the
       Q&A preamble never explicitly overrode it, so the model truncated
       real answers right after the first paragraph.
    
    Changes (Q&A mode only; lecture rendering unchanged):
    - swap lengthGuidelines for QA_LENGTH_GUIDELINES: no char cap,
      depth-matched answers, explicit completeness rule
    - swap formatExample for a plain-text JSON example (no spotlight
      priming)
    - drop spotlightExamples and slideActionGuidelines
    - append QA_MODE_CLOSING after the template so the recency slot says
      'answer the question' instead of 'teach the slide'

 lib/orchestration/prompt-builder.ts | 69 +++++++++++++++++++++++++++++++------
 1 file changed, 58 insertions(+), 11 deletions(-)

commit 077d92b99dce90f420f7dd9dec88aea300c4fa3c
Author: laixue-bot <laixue-bot@local>
Date:   Sat Jul 18 22:23:46 2026 +0800

    fix(qa): route multi-agent Q&A to agent_generate instead of skipping it
    
    f74faec returned shouldEnd=true from the multi-agent Q&A branch,
    intending "dispatch once, then end". But directorCondition evaluates
    shouldEnd BEFORE routing to agent_generate, so the graph went
    director->END and the agent never ran: the student saw total silence
    and the client marked the session completed (totalAgents=0).
    
    Fix: move the Q&A short-circuit before the director LLM call and
    return shouldEnd=false so the conditional edge routes to
    agent_generate. agentGenerateNode already emits cue_user after the
    agent turn, so the client loop exits after exactly one answer.
    
    Also:
    - skips the wasted director LLM call on the Q&A path (one less
      MiniMax round-trip per question) and removes the silent-failure
      mode where a failing director call ended the session
    - removes the duplicated single-agent block (dead code)

 lib/orchestration/director-graph.ts | 76 +++++++++++++------------------------
 1 file changed, 27 insertions(+), 49 deletions(-)

commit 2755e48c16e9d4529bfa0e0984b2acc890fb6ae5
Author: laixue-bot <laixue-bot@local>
Date:   Sat Jul 18 20:36:19 2026 +0800

    fix(qa): prepend Q&A preamble to full prompt instead of replacing it
    
    Previous design (commit 77b6b20) replaced the entire system prompt
    with buildQASystemPrompt in Q&A mode. That put the model in an
    information vacuum: no slide content, no action guidelines, no prior
    history. When the user's question was loosely related to the current
    slide, the model latched onto the slide title and produced a
    one-sentence non-answer like '我们先来看面试官的四级量表——左边这部分'.
    
    New design: keep the full template-rendered system prompt (role, persona,
    action guidelines, slide context, history) and PREPEND a short Q&A
    hard-rule preamble at the TOP. The preamble puts anti-lecture
    directives in the highest-attention region while preserving all the
    context the model needs to actually answer the question.
    
    Changes:
    - prompt-builder.ts: add QA_MODE_PREAMBLE; change 'if (isUserQA) return
      buildQASystemPrompt(...)' to 'return preamble + full prompt'.
    - director-graph.ts: stop stripping history in Q&A mode (model needs
      prior context to anchor follow-up answers).
    - state-context.ts: drop concise-mode skipping of slide elements
      (model needs slide content in Q&A to answer concretely).
    
    buildQASystemPrompt is preserved but no longer called.

 lib/orchestration/director-graph.ts            | 13 +++--
 lib/orchestration/prompt-builder.ts            | 69 ++++++++++++++++++++------
 lib/orchestration/summarizers/state-context.ts |  9 ++--
 3 files changed, 65 insertions(+), 26 deletions(-)

commit 753f6e667775818cc8ba860d90ccda6b343b022d
Author: laixue-bot <laixue-bot@local>
Date:   Fri Jul 17 13:53:02 2026 +0800

    fix(qa): wire sessionType through OrchestratorState so isUserQA fires reliably

 lib/orchestration/director-graph.ts | 30 +++++++++++++++++++++++++++---
 1 file changed, 27 insertions(+), 3 deletions(-)

commit 77b6b20b3df2151db1ad66facd4c3423ee602763
Author: Codex <codex@local>
Date:   Thu Jul 16 19:14:57 2026 +0800

    fix(roundtable): completely replace prompt in Q&A mode, don't append
    
    Six attempts in this chain (6661ed7 → 248447b → 02bd0d9 → e88c55c
    → 7f14436 → 67d9879) tried to coerce the teacher into answering a
    user question directly. None of them stuck. Latest screenshot
    still shows the teacher narrating chapter intro instead of
    answering the student's question.
    
    Root cause: every previous attempt tried to append a CRITICAL
    directive to the end of a long, template-rendered system prompt.
    LLMs weight the BEGINNING of the prompt much more than the tail —
    the late directive was drowned out by 600 lines of template-rendered
    content (state context, slide elements, format examples, role
    guidelines) telling the model what to do in 'lecture' mode.
    
    Fix: in Q&A mode (isUserQA=true), completely skip the template
    and return a focused ~30-line system prompt built just for
    answering a user question. The new prompt is rule-driven (every
    line is either an anti-lecture rule or a length anchor), uses
    the scene title only as an optional reference, and never injects
    the rich lecture scaffolding that triggered narration.
    
    Structure of the new prompt:
      ROLE            — speaker identity
      ABSOLUTE RULES  — 6 rules (answer-only, no lecture openers, no tools)
      LENGTH          — 1 sentence / 2-4 sentences / multi-paragraph
      ANCHOR          — scene title only, when question is specifically about this slide
      PRIOR TURNS     — don't repeat peer agents
    
    tsc --noEmit: 0 errors.

 lib/orchestration/prompt-builder.ts | 98 +++++++++++++++++++++++++++++++------
 1 file changed, 83 insertions(+), 15 deletions(-)

commit a682cbc7a3bd2797518a56538bf8d4c9335b3040
Author: Codex <codex@local>
Date:   Wed Jul 15 14:27:33 2026 +0800

    fix(mobile): let admin / teacher browse /m without a student-row binding
    
    The /m/[id] learner surface required a row in public.students
    linked to the signed-in user. Admins and teachers, by policy,
    have implicit access to every published course (they don't
    need to be 'invited' as students), so the '还没绑定学员档案'
    card was misleading.
    
    Same logic as the existing /student/courses (admin role check
    sits on the server before the student lookup). On /m we now:
    
    - Read the caller's profile.role first
    - If role is 'admin' or 'teacher' (isStaff), skip the student
      lookup and render the course list directly
    - The header shows the admin/teacher name + a '管理员视角' label
    
    PC /student/courses keeps its existing redirect-to-/admin
    behavior (different IA on desktop). Mobile stays permissive so
    admin/teacher can preview the learner experience.
    
    tsc --noEmit: 0 errors.

 app/m/page.tsx | 34 ++++++++++++++++++++++++----------
 1 file changed, 24 insertions(+), 10 deletions(-)

commit fda28ddbfaeab4322459d61fd4793990d6e12695
Author: Codex <codex@local>
Date:   Wed Jul 15 12:07:15 2026 +0800

    fix(mobile): auto-generate TTS for chapters without pre-rendered audio
    
    The previous AudioPlayer only played when the chapter's scene
    had a pre-rendered audioUrl from the OPENMAIC course generator.
    If a chapter was missing audioUrl (e.g. older course that
    predates audio generation, or audioGeneration was skipped on
    save), the player showed '🎧 暂无语音' and playback effectively
    stopped at the first silent chapter.
    
    This change implements a TTS fallback: when audioUrl is absent,
    the player calls /api/generate/tts with the chapter's narration
    text and the user's current MiniMax voice. The endpoint returns
    base64-encoded audio; we decode it into a Blob and feed the Blob
    URL to the <audio> element. Autoplay still fires via key={src}
    remount + onLoadedMetadata → el.play(), so the chain works
    across chapters:
    
      ch1 audioUrl = A.mp3 → plays → onEnded → ch2 audioUrl = B.mp3
      ch2 audioUrl missing → /api/generate/tts fires → Blob URL
        → key changes → element remounts → autoplay → ch2 audio plays
    
    Implementation notes:
    - TTS state machine: idle / loading / ready / error.
    - ttsRequestIdRef guards against stale responses when the user
      scrubs chapters faster than the TTS API.
    - Text is capped at 1500 chars per call to bound cost. Multi-
      chapter TTS is paid per chapter (~600–2000 tokens MiniMax each).
    - retry button resets state and re-fires the request.
    - audioUrl is still preferred (zero-cost, no LLM round-trip).
    
    tsc --noEmit: 0 errors.

 app/m/[id]/_components/AudioPlayer.tsx | 148 +++++++++++++++++++++++++++++----
 1 file changed, 132 insertions(+), 16 deletions(-)

commit 903722532c7d92e976a126e2f35e51d342c42676
Author: Codex <codex@local>
Date:   Wed Jul 15 11:15:16 2026 +0800

    fix(mobile): paragraphs + sticky bottom dock + autoplay next chapter
    
    Two UX issues reported by the user with screenshots from 小宇宙
    (podcast reference) and the current RJ-laixue mobile player:
    
    1. Layout — playback controls were buried at the bottom of the page
       instead of pinned to the viewport. The user had to scroll all
       the way down to reach ▶/⏸ and the chapter buttons. 小宇宙
       keeps the controls always visible at the bottom of the screen.
    
       Fix: in MobilePlayer.tsx, restructure to a three-zone layout
       matching the podcast app pattern:
         - top: chapter title (sticky to the page header above)
         - middle: scrolling text (flex-1, overflow-y-auto)
         - bottom dock: progress + audio + chapter buttons
           (sticky bottom-0, with bg-background + top border + soft
           shadow so it visually separates from the text)
    
       Bonus: split narration into paragraphs. New splitParagraphs()
       in TextScript.tsx splits on Chinese full stops (。！？) and
       English sentence terminators, falling back to the input
       verbatim if the text already contains \n. Each paragraph is
       rendered as its own <p> with mb-4 + indent-[2em], matching
       the feel of a printed transcript.
    
    2. Playback — audio paused when navigating to the next chapter.
       Root cause: when the chapter changed, sceneIndex updated and
       the <audio src=...> received a new URL, but the browser does
       not auto-play a freshly-loaded audio element. The user had
       to manually press ▶ each time.
    
       Fix in AudioPlayer.tsx:
         - Add key={audioUrl} to the <audio> element so React fully
           remounts the element when the src changes (rather than
           mutating the existing one, which can leave it in the
           paused state)
         - Add autoPlay attribute (declarative hint)
         - Call el.play() inside onLoadedMetadata so the autoplay
           actually fires after metadata loads
    
       iOS Safari note: autoplay can still be silently blocked if no
       user gesture has fired yet. We surface that as an error toast
       instead of pretending playback is happening.
    
    tsc --noEmit: 0 errors.

 app/m/[id]/_components/AudioPlayer.tsx  |  12 +++-
 app/m/[id]/_components/MobilePlayer.tsx | 119 +++++++++++++++++---------------
 app/m/[id]/_components/TextScript.tsx   |  52 +++++++++++---
 3 files changed, 117 insertions(+), 66 deletions(-)

commit c97c85836ed29e1cf4c94bdc36cf985b9ea5ff29
Author: Codex <codex@local>
Date:   Wed Jul 15 09:55:57 2026 +0800

    feat(mobile): /m/[id] mobile learner surface (Phase 1)
    
    Implements PRD-mobile.md Phase 1 (P0 features). Mobile entry is a
    阉割版 of /classroom/[id]: text + audio + AI Q&A only. No
    whiteboard, no spotlight, no Pro Mode.
    
    Routes
    - /m              — auth-gated course list (server component)
    - /m/[id]         — single-course player (RSC shell + client player)
    
    Server-side libs (lib/mobile/)
    - course-data.ts       — loadMobileCourse() — server-side service_role fetch
                             of one course's stage + scenes + outlines
    - scene-helpers.ts     — buildChapters() — converts OPENMAIC Scene[] to
                             flat MobileChapter[] (text + audioUrl + duration)
    - progress.ts          — localStorage per-course resume (sceneIndex + offset)
    - question-limit.ts    — localStorage per-course Q&A counter (5/pilot)
    
    Client components (app/m/[id]/_components/)
    - MobilePlayer.tsx       — orchestrator: text + audio + AI dialog state
    - TextScript.tsx         — narration text with auto-scroll (pauses 3s on
                               manual scroll)
    - AudioPlayer.tsx        — <audio> with 0.75x/1x/1.25x/1.5x rate + ▶/⏸ + progress
    - AIQuestionDialog.tsx   — half-sheet modal, Enter to send, streams /api/chat
                               SSE, marks limit
    - ProgressBar.tsx       — current/total chapters + percent
    
    Auth
    - Reuses Supabase Auth via @supabase/ssr createServerClient
    - Reuses /api/chat (the existing PC endpoint) for AI Q&A — no new
      backend route needed. Passes apiKey + baseUrl + model from
      getCurrentModelConfig() so the server uses the user's
      server-configured provider (MiniMax from admin env vars).
    
    Behaviour per PRD
    - /m pages redirect to /login?next=/m when unauthenticated
    - Quiz / interactive / pbl scene types play narration text only —
      no interactions rendered
    - AI 伴学 appears only in Q&A replies (playback flow has teacher
      audio only — no two voices at once)
    - 5 questions per course per pilot — counter local + UI show
      '还剩 N/5', button disables at 0
    - Closing the dialog resumes playback from the paused position
    
    Known limitations (Phase 1.5+)
    - No fallback TTS for scenes without audioUrl — shows '暂无语音'
    - localStorage question counter is client-only (Phase 2 adds
      server-side enforcement via course_progress_events)
    - Auto-scroll drifts 20px/sec; precise word-sync is Phase 2
    
    tsc --noEmit: 0 errors.

 app/m/[id]/_components/AIQuestionDialog.tsx | 182 ++++++++++++++++
 app/m/[id]/_components/AudioPlayer.tsx      | 160 ++++++++++++++
 app/m/[id]/_components/MobilePlayer.tsx     | 322 ++++++++++++++++++++++++++++
 app/m/[id]/_components/ProgressBar.tsx      |  32 +++
 app/m/[id]/_components/TextScript.tsx       |  77 +++++++
 app/m/[id]/page.tsx                         |  67 ++++++
 app/m/layout.tsx                            |  35 +++
 app/m/page.tsx                              | 124 +++++++++++
 lib/mobile/course-data.ts                   |  95 ++++++++
 lib/mobile/progress.ts                      |  78 +++++++
 lib/mobile/question-limit.ts                |  65 ++++++
 lib/mobile/scene-helpers.ts                 |  97 +++++++++
 12 files changed, 1334 insertions(+)

commit 2ce0c1de6c02be903faec6bce060da8954c97750
Author: Codex <codex@local>
Date:   Wed Jul 15 09:18:45 2026 +0800

    chore(docs): remove mobile PRD from public serving
    
    The mobile PRD is internal-only (Phase 1 development reference).
    Don't expose it on laixue.work/docs/. Keep only on docs/ in
    the repo (visible to engineers) and as a local copy in the
    worker's output directory.

 public/docs/PRD-mobile.md | 362 ----------------------------------------------
 1 file changed, 362 deletions(-)

commit 236b81f08e7941ac5c5b3de5403142e0f47ce446
Author: Codex <codex@local>
Date:   Tue Jul 14 18:41:46 2026 +0800

    docs: mobile PRD v1.0 — locked for Phase 1 development
    
    Reviewed and approved:
    - Position: mobile is a '阉割版' of PC — text + audio + AI Q&A only
    - /m/[id] independent route (no coupling with /classroom)
    - AI 伴学 appears only in Q&A flow, not in playback flow
      (avoids the 'two voices at once' problem)
    - 章节切换用 buttons (user prefers blog-style, not gestures)
    - 倍速: 0.75x / 1x / 1.25x / 1.5x
    - 提问限制: 5 次/门课 during pilot
    - Quiz / interactive / whiteboard types: skip interactions,
      play narration only
    - 学习进度 localStorage (Phase 2 server-side)
    - 复用 Supabase Auth + TTS + /api/chat
    - 新增 app/m/* routes + lib/mobile/* helpers
    
    Also mirrored to public/docs/PRD-mobile.md so Vercel serves it
    at https://www.laixue.work/docs/PRD-mobile.md for stakeholder
    review.

 docs/PRD-mobile.md        | 362 ++++++++++++++++++++++++++++++++++++++++++++++
 public/docs/PRD-mobile.md | 362 ++++++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 724 insertions(+)

commit 8f465fa4d76861d27a7071048ed587141ff35b1a
Author: Codex <codex@local>
Date:   Tue Jul 14 18:03:48 2026 +0800

    docs(public): add 3 screenshots and replace image placeholders
    
    Screenshots from the user:
    - public/docs/screenshots/login.png       (登录页 - '登录来学')
    - public/docs/screenshots/creator-home.png (创作者首页 - 来学·创课助手 + 输入框)
    - public/docs/screenshots/classroom.png    (教室播放 - 目标管理实施流程)
    
    Replaced 3 image-placeholder divs in product-intro.html with
    actual <img> tags pointing at /docs/screenshots/* so the page
    renders the real UI shots after Vercel deploys.
    
    tsc --noEmit: 0 errors.

 docs/product-intro.html                  |   6 +++---
 public/docs/product-intro.html           |   6 +++---
 public/docs/screenshots/classroom.png    | Bin 0 -> 742772 bytes
 public/docs/screenshots/creator-home.png | Bin 0 -> 140797 bytes
 public/docs/screenshots/login.png        | Bin 0 -> 19475 bytes
 5 files changed, 6 insertions(+), 6 deletions(-)

commit e81171e7d234181a22c2e28d1f40f50dbc3d042d
Author: Codex <codex@local>
Date:   Tue Jul 14 17:59:51 2026 +0800

    docs(public): update product intro with finalized copy from Feishu wiki
    
    Incorporates the version edited and approved by the user in the
    Feishu wiki at Dd31wvPJXimLluk7bh7ccNHDn4f. Changes from the
    previous draft:
    
    - Combined the product intro + user manual into a single page
      (user confirmed '使用方法直接放你创建好的用户即可' — the
      detailed steps belong on this page, not a separate manual)
    - Added the official demo account (laixue@laixue.com / B8pvqpwg65nD)
      in a green demo card
    - Added the '测试用例' blockquote with the '锐捷管理基本功'
      example prompt that creators can try
    - Added image placeholders for the screenshots the user attached
      to the wiki (登录页 / 创作者首页 / 生成中 / 完成 / 保存 / 分享 /
      管理员后台 / 学员首页)
    - Same three-audience structure (creator / admin / learner)
    - Same FAQ section
    
    HTML + public/docs/ kept in sync via sync-public-docs.mjs script.
    
    tsc --noEmit: 0 errors.

 docs/product-intro.html        | 300 ++++++++++++++++++++++++++++-------------
 public/docs/product-intro.html | 300 ++++++++++++++++++++++++++++-------------
 2 files changed, 420 insertions(+), 180 deletions(-)

commit 6533dcea48317849938f3b4ccfa680e184d70762
Author: Codex <codex@local>
Date:   Tue Jul 14 17:38:59 2026 +0800

    chore(scripts): add sync-public-docs helper
    
    Run 'node scripts/sync-public-docs.mjs' (or wire into prebuild)
    to mirror public-facing HTML from docs/ to public/docs/ where
    Vercel will serve them.

 scripts/sync-public-docs.mjs | 53 ++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 53 insertions(+)

commit 32d4b40c28ac12b20a1d624740960eb95a122051
Author: Codex <codex@local>
Date:   Tue Jul 14 17:38:22 2026 +0800

    fix(docs): mirror public-facing HTML to public/docs for Vercel serving
    
    Vercel does not auto-serve files from the project's docs/
    directory — only files under public/ are exposed as static
    assets at the matching URL path. Copy product-intro.html and
    user-manual.html into public/docs/ so Vercel exposes them at:
    
      https://www.laixue.work/docs/product-intro.html
      https://www.laixue.work/docs/user-manual.html
    
    The docs/ versions stay as the canonical source. The
    public/docs/ copies are rebuilt on every commit (you can also
    symlink, but copy keeps the deploy self-contained).

 public/docs/product-intro.html | 203 ++++++++++++++++++++++++++++++++
 public/docs/user-manual.html   | 256 +++++++++++++++++++++++++++++++++++++++++
 2 files changed, 459 insertions(+)

commit 69d35a3e9a9d38fc1c75bc39de8ba08b82b0497c
Author: Codex <codex@local>
Date:   Tue Jul 14 17:31:10 2026 +0800

    docs: user manual HTML for public sharing
    
    Same three-audience structure as the product intro: creator /
    admin / learner + FAQ. Can be opened directly in browser or pasted
    into Feishu docs with Ctrl+A → Ctrl+C → Ctrl+V.

 docs/user-manual.html | 256 ++++++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 256 insertions(+)

commit 19894c73ba378a888dcc0786268291bfcb69ca6e
Author: Codex <codex@local>
Date:   Tue Jul 14 17:28:44 2026 +0800

    docs: add public-facing product intro (HTML + Markdown)
    
    Two documents for sharing 来学·创课助手 with other departments
    during the pilot presentation:
    
    1. docs/product-intro.html — formatted HTML page (green theme
       matching the app), with hero card + features + audience
       sections + demo access info + 4-step usage flow. Can be
       shared directly on web or pasted into Feishu docs.
    
    2. docs/README-public.md — Markdown version of the same content,
       plus a link table to all the deeper documentation:
       - product-intro.html
       - user-manual.html (next commit)
       - PRD.md
       - DEV.md
    
    These will be served from Vercel at laixue.work/docs/* once
    deployed.
    
    tsc --noEmit: 0 errors.

 docs/README-public.md   |  67 ++++++++++++++++
 docs/product-intro.html | 203 ++++++++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 270 insertions(+)

commit 67d98790173ceac48000740410ca42c2c37688d0
Author: Codex <codex@local>
Date:   Tue Jul 14 16:59:51 2026 +0800

    fix(prompt): drop 2-3 sentence cap in Q&A mode
    
    Previous version capped answers at 2-3 sentences. That was a
    defensive limit added while I was trying to stop the teacher
    from narrating slide content. Now that the loop is fixed
    (commit e88c55c) the teacher only runs once and never narrates,
    so the cap is no longer needed — and was actively wrong for
    substantive questions ('how do I deal with X' deserves a
    thorough answer, not 2 sentences).
    
    New instruction: 'Answer the question in as much detail as
    needed — short questions get short answers, deep questions
    get thorough answers. The right length is whatever the question
    deserves.'
    
    tsc --noEmit: 0 errors.

 lib/orchestration/prompt-builder.ts | 7 ++++---
 1 file changed, 4 insertions(+), 3 deletions(-)

commit e88c55ca250c2ccc8e8bb575e6e289322ee4001a
Author: Codex <codex@local>
Date:   Tue Jul 14 16:55:55 2026 +0800

    fix(director): emit cue_user after agent turn in Q&A mode
    
    The client-side while(true) loop in lib/chat/agent-loop.ts only
    exits when it receives a 'cue_user' SSE event. Returning shouldEnd
    from the LangGraph director node is server-side state and NEVER
    reaches the client. As a result, the Q&A flow was looping:
    
      user asks question
      → director dispatches teacher (shouldEnd=true)
      → agent runs, emits text
      → director condition: shouldEnd=true → END (server exits)
      → BUT client never saw cue_user → client loop runs again
      → NEW chat request with same messages → another teacher turn
      → 4 teacher turns chained (matches the 4 messages in the user's
        screenshot)
    
    Fix: in agentGenerateNode, when state.messages contains a user
    message (Q&A mode), emit a 'cue_user' SSE event to the client
    before returning. The client's onCueUser callback sets
    loopDoneDataRef.cueUserReceived=true, which makes the while(true)
    loop return. The teacher node only runs once.
    
    tsc --noEmit: 0 errors.

 lib/orchestration/director-graph.ts | 29 ++++++++++++++++++++++++++---
 1 file changed, 26 insertions(+), 3 deletions(-)

commit f74faec7e8ca0402284c9c6eabb8840de0daeb1d
Author: Codex <codex@local>
Date:   Tue Jul 14 14:44:26 2026 +0800

    fix(director): Q&A mode = single teacher turn, no multi-agent loop
    
    Even after stripping prior AIMessages and adding a CRITICAL Q&A
    directive, the teacher still narrated slide content. Root cause:
    the LangGraph director was looping — it dispatched the teacher,
    the teacher emitted a Spotlight action + narration, then director
    looped back to 'agent_generate' and dispatched teacher AGAIN,
    chaining multiple teacher turns. From the user's perspective,
    the teacher was 'lecturing' instead of answering.
    
    OpenMAIC's director in multi-agent mode asks an LLM 'who speaks
    next?' and keeps the session alive until the LLM returns USER or
    END. With multiple agents available (teacher + assistants), the
    LLM almost never says 'USER' after a user question — it picks the
    teacher again, who is primed by prior slide context to lecture.
    
    Fix: in director node, if state.messages contains a user message,
    skip the LLM-based director decision entirely. Dispatch the teacher
    once and return shouldEnd=true so the LangGraph loop exits. The
    teacher node still gets the Q&A directive + clean message history
    (from the previous commit), so the single response is the direct
    answer.
    
    For single-agent mode, also dispatch on user message instead of
    cue_user — same reasoning, let the agent run once with Q&A mode.
    
    tsc --noEmit: 0 errors.

 lib/orchestration/director-graph.ts | 60 ++++++++++++++++++++++++++++++++-----
 1 file changed, 53 insertions(+), 7 deletions(-)

commit 02bd0d975acb105b11e5e8e47150104f8efd9263
Author: Codex <codex@local>
Date:   Mon Jul 13 17:04:35 2026 +0800

    fix: strip prior narration in Q&A + always-visible share toast
    
    Two bug fixes:
    
    1. director-graph.ts: even with 'CRITICAL — STUDENT QUESTION MODE'
       in the system prompt, the teacher kept narrating slide content
       in Q&A mode. Root cause: state.messages includes the PREVIOUS
       teacher AIMessages ('各位管理者好，今天我们进入 SMART 原则...').
       The model sees those in history and continues that style of
       narration for the new turn, ignoring the prompt directive.
    
       Fix: when isUserQA, keep ONLY the user's most recent message
       in the conversation history. All prior agent narration is
       dropped. The model can no longer pattern-match on its earlier
       'teach the slide' turn.
    
    2. cloud-courses.tsx: '分享' click seemed to flash with no
       feedback. The setShareMessage(...) text was rendered below the
       two sections but off-screen or scrolled away on long lists.
       Fix: also show a fixed-position green toast at top-center for
       4 seconds, and stash the URL on window.lastShareUrl as a
       recovery hook for browsers that no-op navigator.clipboard
       despite reporting success.
    
    tsc --noEmit: 0 errors.

 components/cloud-courses.tsx        | 19 ++++++++++++++++++-
 lib/orchestration/director-graph.ts | 15 ++++++++++++---
 2 files changed, 30 insertions(+), 4 deletions(-)

commit 016511fd951a6f84baef189192523dc148b04b5f
Author: Codex <codex@local>
Date:   Mon Jul 13 14:10:48 2026 +0800

    feat(library): split into '我的课程' (mine) and '云端课程' (discover)
    
    Restructure the cloud courses roster into two sections with
    owner-scoped permissions, mirroring the OPENMAIC upstream pattern
    of '发现' (discover) and '我的课程' (mine).
    
    SQL:
      - supabase-courses-owner.sql: add created_by uuid column to
        public.courses (references auth.users, ON DELETE SET NULL).
        Index for the 'list mine' query.
    
    API:
      - GET /api/courses?scope=all (default): all courses, no filter.
        Used for the discover section.
      - GET /api/courses?scope=mine: filtered by created_by =
        authed user's id (via cookie session). Returns [] if not
        signed in.
      - POST /api/courses: now stamps created_by = authed user.id on
        every save. 401 if not signed in.
      - DELETE /api/courses/[id]: now checks ownership before
        deleting. 401 if not signed in, 403 if not the owner.
        Always filters by id AND created_by on the actual delete for
        defense in depth.
    
    client:
      - lib/utils/cloud-sync.ts: listMyCourses() added alongside
        listCloudCourses(). Both return the same shape including
        created_by so the client can decide ownership.
      - components/cloud-courses.tsx: two sections ('📚 我的课程' +
        '🌐 云端课程（发现）'), each rendered with the same CourseCard
        component. CourseCard receives an isOwner prop and shows
        '编辑' + '🗑 删除' only when isOwner. Shared buttons
        ('打开' / '分享') show in both sections.
    
    tsc --noEmit: 0 errors.

 app/api/courses/[id]/route.ts |  45 ++++++++-
 app/api/courses/route.ts      |  45 +++++++--
 components/cloud-courses.tsx  | 229 ++++++++++++++++++++++++++++++------------
 lib/utils/cloud-sync.ts       |  27 ++++-
 supabase-courses-owner.sql    |  20 ++++
 5 files changed, 292 insertions(+), 74 deletions(-)

commit 7f14436a9c1a9ee7542df28ab9167d7ae6df07f0
Author: Codex <codex@local>
Date:   Mon Jul 13 12:54:47 2026 +0800

    fix: stronger Q&A directive + hide save button in view mode
    
    Three fixes:
    
    1. prompt-builder.ts: strengthen the CRITICAL Q&A directive.
       Previous version said 'answer directly' but the model still
       said one sentence of slide narration ('各位管理者好，今天我们
       进入...'). New version explicitly FORBIDS:
       - introducing the course / slide / topic
       - saying '让我们来看' / '我们进入' / '今天我们'
       - using spotlight/laser actions
       And demands: 'Your FIRST word must be the direct answer.'
    
    2. cloud-courses.tsx: '打开' button now opens /classroom/{id}?view=1
       instead of plain /classroom/{id}. The ?view=1 flag tells the
       classroom page this is a read-only viewing context.
    
    3. classroom/[id]/page.tsx: save-to-cloud button gate now includes
       !viewMode — when ?view=1 is on the URL, the save button is
       hidden even for admin/teacher. This prevents the button from
       appearing when a teacher clicks '打开' to preview a course.
       The button still shows after course generation (no ?view=1)
       and in Pro Mode (?editor=1).
    
    tsc --noEmit: 0 errors.

 app/classroom/[id]/page.tsx         |  3 ++-
 components/cloud-courses.tsx        |  2 +-
 lib/orchestration/prompt-builder.ts | 12 ++++++------
 3 files changed, 9 insertions(+), 8 deletions(-)

commit 248447bf08875d04e0753143d000f1b29cc3f753
Author: Codex <codex@local>
Date:   Mon Jul 13 11:01:04 2026 +0800

    fix(roundtable): skip slide details + force direct answer in Q&A mode
    
    Previous fix (6661ed7) added a 'answer directly' instruction to the
    teacher role guideline, but the model still narrated slide content
    because buildStateContext stuffed every slide element's text into
    the system prompt — the model saw the content and couldn't resist
    'teaching' it.
    
    Three coordinated changes:
    
    1. state-context.ts: buildStateContext now accepts a 'concise' flag.
       When true, it skips the 'Current slide elements' section entirely
       — the model only sees the scene title, not the text on the slide.
       It can't narrate what it can't see.
    
    2. prompt-builder.ts: buildStructuredPrompt now accepts 'isUserQA'.
       When true:
       - Passes concise=true to buildStateContext (no slide elements)
       - Appends a 'CRITICAL — STUDENT QUESTION MODE' directive AFTER
         the template, so it's the last thing the model reads before
         the conversation history. The directive explicitly forbids
         walking through, narrating, or summarizing slide content.
    
    3. director-graph.ts: detect user-initiated Q&A by checking if
       state.messages contains a user-role message. Pass isUserQA=true
       to buildStructuredPrompt only when the user asked a question
       (not during lecture narration or agent-initiated discussion).
    
    Effect:
      - Lecture mode (no user message): full slide content in prompt →
        teacher narrates slides normally ✅
      - Q&A mode (user asked question): NO slide element details +
        'answer directly' directive → teacher answers the question
        without narrating ✅
    
    tsc --noEmit: 0 errors.

 lib/orchestration/director-graph.ts            |  5 +++++
 lib/orchestration/prompt-builder.ts            | 18 +++++++++++++++++-
 lib/orchestration/summarizers/state-context.ts | 11 ++++++++---
 3 files changed, 30 insertions(+), 4 deletions(-)

commit 7ef2394e488e077b51b9b2279ed8b21fd4878b8d
Author: Codex <codex@local>
Date:   Mon Jul 13 10:04:02 2026 +0800

    fix(tts): override browser-native-tts to server TTS on every sync
    
    Two fixes for the classroom Q&A experience:
    
    1. lib/store/settings.ts: the auto-select logic that picks the
       server TTS provider (e.g. MiniMax) only ran on the FIRST visit
       (guarded by !autoConfigApplied). If a user first visited before
       TTS was configured, autoConfigApplied got set to true with
       ttsProviderId='browser-native-tts' (the default). Subsequent
       fetchServerProviders calls never re-selected the server TTS —
       real-time Q&A used the browser's built-in voice instead of the
       MiniMax voice used during course generation.
    
       Fix: add a fallback OUTSIDE the autoConfigApplied guard that
       checks if ttsProviderId is still 'browser-native-tts' but the
       server has a configured TTS provider. If so, override to the
       server provider + its default voice + enable TTS. This runs
       on EVERY server sync, not just first run.
    
    2. lib/orchestration/prompt-builder.ts (already committed in
       6661ed7): teacher answers questions directly without
       re-narrating slide content.
    
    tsc --noEmit: 0 errors.

 lib/store/settings.ts | 24 ++++++++++++++++++++++++
 1 file changed, 24 insertions(+)

commit 6661ed760fec7a3d9c822c18c4b0341b0053942c
Author: Codex <codex@local>
Date:   Sun Jul 12 23:02:43 2026 +0800

    fix(roundtable): teacher answers directly without re-narrating slide
    
    OPENMAIC upstream's buildStateContext stuffs the full slide content
    (text elements, positions, sizes) into the system prompt. The
    teacher agent saw all this content and started narrating it before
    actually answering the student's question — 4+ sentences of slide
    summary before the real answer.
    
    Add a CRITICAL instruction to the teacher role guideline:
    'When a student asks a question, answer it DIRECTLY. Do NOT
    re-explain, summarize, or narrate the current slide content first —
    the student has already seen it. Only reference specific slide
    elements if the question is specifically about them. Skip any
    preamble like Let me explain this slide or As shown on this page
    — get straight to the answer.'
    
    tsc --noEmit: 0 errors.

 lib/orchestration/prompt-builder.ts | 4 +++-
 1 file changed, 3 insertions(+), 1 deletion(-)

commit ffd1e77eaab3412ba377749e1ee02aafe322e50d
Author: Codex <codex@local>
Date:   Sun Jul 12 13:20:38 2026 +0800

    fix(classroom): show save-to-cloud button based on role, not URL
    
    The previous gate (editorAutoOpen) hid the '保存到云端' button from
    admins on the post-generation page because that page's URL is
    /classroom/[id] without ?editor=1. Admins generate a course, land
    on /classroom/[id], and need to save — but the button was gone.
    
    Switch from URL-based gate to role-based gate:
      canSave = profile.role === 'admin' || profile.role === 'teacher'
    
    This way:
      - Admin/teacher after generation → button shows ✅
      - Admin/teacher in Pro Mode (?editor=1) → button shows ✅
      - Learner viewing a course → button hidden ✅
    
    tsc --noEmit: 0 errors.

 app/classroom/[id]/page.tsx | 9 +++++++--
 1 file changed, 7 insertions(+), 2 deletions(-)

commit ca95510868c49f6e95bfdc898f79467388d6359c
Author: Codex <codex@local>
Date:   Sun Jul 12 12:40:22 2026 +0800

    feat(theme): purple → green primary + rename '最近学习' → '我的课程'
    
    Two visual changes per admin feedback:
    
    1. app/globals.css: --primary changed from #722ed1 (purple) to
       #16a34a (green-600) in light theme, and from #8b47ea to
       #22c55e (green-500) in dark theme. This affects all Tailwind
       classes that reference --primary: bg-primary, text-primary,
       border-primary, ring-primary, etc. — buttons, links, focus
       rings, active states all turn green.
    
       Note: app/generation-preview/components/visualizers.tsx has
       hardcoded purple-*/violet-* classes for specific preview
       thumbnail gradients. These are NOT changed — they're cosmetic
       per-element styling, not the theme primary. Can be changed
       separately if needed.
    
    2. lib/i18n/locales/zh-CN.json: 'recentClassrooms' renamed from
       '最近学习' to '我的课程'. English (en-US) changed from 'Recent'
       to 'My Courses'. The section title on the home page now reads
       '我的课程' for admin/teacher users, which better reflects that
       these are the user's created courses (not just 'recently
       learned' which implies a learner perspective).
    
    tsc --noEmit: 0 errors.

 app/globals.css             | 4 ++--
 lib/i18n/locales/en-US.json | 2 +-
 lib/i18n/locales/zh-CN.json | 2 +-
 3 files changed, 4 insertions(+), 4 deletions(-)

commit b54d7eeb498600d6e327df5e781624e8b6fd0690
Author: Codex <codex@local>
Date:   Sun Jul 12 12:23:02 2026 +0800

    feat(rls): wave 3-5 — all learning APIs to service_role + drop anon SELECT
    
    Wave 3: lib/server/learning-mvp.ts was the last server module
    using the anon browser client to read AND write students /
    course_assignments / course_progress_events. Switched to
    getServiceSupabase() (module-level const, all callers are
    server-side API routes).
    
    Wave 4: lib/utils/cloud-sync.ts listCloudCourses and
    importCourseFromCloud were the last client-side functions reading
    directly from the courses table via the anon browser client.
    Changed both to call /api/courses GET (which uses service_role).
    Combined with the earlier deleteCloudCourse change, cloud-sync.ts
    no longer touches any Supabase table directly — all operations
    route through API endpoints.
    
    Wave 5: supabase-rls-tighten-wave5.sql drops the remaining 4 anon
    SELECT policies (students, course_assignments,
    course_progress_events, courses). After this, the anon key can
    do NOTHING on any learning table — the public key is effectively
    read-only-dead. All operations go through:
      - service_role (server-side API routes)
      - authenticated (signed-in users, where policies exist)
    
    The anon key is still embedded in the client bundle (it has to be,
    for Supabase Auth to work), but it can no longer read or modify
    any business data.
    
    tsc --noEmit: 0 errors.

 lib/server/learning-mvp.ts     | 10 +++++++++-
 lib/utils/cloud-sync.ts        | 26 +++++++++++++-------------
 supabase-rls-tighten-wave5.sql | 37 +++++++++++++++++++++++++++++++++++++
 3 files changed, 59 insertions(+), 14 deletions(-)

commit fc2b1d68e6fbba7404c7dff3003ff1533bca4f50
Author: Codex <codex@local>
Date:   Sun Jul 12 12:16:49 2026 +0800

    feat(rls): wave 2 — enable RLS on courses + API routes to service_role
    
    Three coordinated changes:
    
    1. supabase-rls-tighten-wave2.sql: enable RLS on public.courses
       (previously un-RLS'd — anyone with the anon key could read AND
       write freely). Add SELECT policies for anon + authenticated so
       client-side reads (listCloudCourses, importCourseFromCloud)
       still work. No INSERT/UPDATE/DELETE policies — writes must go
       through /api/courses/* which uses service_role.
    
    2. app/api/courses/route.ts + [id]/route.ts: switch from
       @/lib/supabase/client (anon browser client) to
       @/lib/supabase/server getServiceSupabase() (service_role).
       The API routes are server-side, so they can use the privileged
       key that bypasses RLS. GET (list), POST (upsert/save), GET [id]
       (single), DELETE [id] all go through service_role now.
    
    3. lib/utils/cloud-sync.ts: deleteCloudCourse was directly deleting
       from public.courses via the anon browser client. After RLS is
       enabled, this would fail (no anon DELETE policy). Changed to
       call DELETE /api/courses/[id] via fetch, which goes through
       the service_role API route.
    
    Effect:
      - anon key can only SELECT courses (read)
      - Writes (save, delete) must go through /api/courses/* (service_role)
      - Client-side cloud-courses.tsx '打开' '分享' '🗑 删除' all still
        work — delete now routes through API
      - /student/courses reads via service_role (admin page) — unaffected
    
    tsc --noEmit: 0 errors.

 app/api/courses/[id]/route.ts  |  8 +++++---
 app/api/courses/route.ts       |  8 +++++---
 lib/utils/cloud-sync.ts        | 15 ++++++++++-----
 supabase-rls-tighten-wave2.sql | 40 ++++++++++++++++++++++++++++++++++++++++
 4 files changed, 60 insertions(+), 11 deletions(-)

commit 9b99e5fa41c1721afadb61bd6dae78ef65a76702
Author: Codex <codex@local>
Date:   Sun Jul 12 11:39:50 2026 +0800

    fix(classroom): add authReady to loadClassroom deps so it re-fires
    
    When authLoading flips from true to false, authReady changes from
    false to true. But loadClassroom's useCallback deps didn't include
    authReady, so the function reference stayed the same, and the
    useEffect that calls loadClassroom() never re-fired — leaving the
    page stuck on 'Loading classroom...' forever.
    
    Add authReady to the useCallback deps. When it changes, loadClassroom
    gets a new reference, the useEffect re-fires, and this time the
    'if (!authReady) return' guard passes and loading proceeds.
    
    tsc --noEmit: 0 errors.

 app/classroom/[id]/page.tsx | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

commit 6fa5cac568362f269836abf0a8daddc0aec1b360
Author: Codex <codex@local>
Date:   Sun Jul 12 11:23:30 2026 +0800

    fix(classroom): move auth gate after all hooks to fix React #310
    
    React error #310 'Rendered fewer hooks than expected' was caused by
    early returns (if authLoading / if !user) placed BEFORE other hooks
    (useStageStore, useRef, useSceneGenerator, useCallback, etc.).
    
    React requires hooks to be called in the same order on every render.
    When authLoading flipped from true to false, the number of hooks
    called changed → crash.
    
    Fix:
    - Remove the early returns entirely
    - Move the conditional return to AFTER all hooks (just before the
      main JSX return)
    - Add 'if (!authReady) return' inside loadClassroom callback so
      data loading is skipped while auth is unresolved
    
    tsc --noEmit: 0 errors.

 app/classroom/[id]/page.tsx | 39 +++++++++++++++++++++++----------------
 1 file changed, 23 insertions(+), 16 deletions(-)

commit 1b2465faf5610241fd83211414d7832268bbead0
Author: Codex <codex@local>
Date:   Sun Jul 12 10:48:40 2026 +0800

    fix(classroom): Supabase Auth gate replaces ACCESS_CODE modal
    
    OPENMAIC upstream shipped a global ACCESS_CODE modal (middleware +
    AccessCodeGuard) that intercepted every page load and asked for a
    shared access code. RJ-laixue's account system makes that redundant
    — learners sign in with email + password, not a shared code.
    
    This commit adds a Supabase Auth gate directly to /classroom/[id]:
      - useAuth() hook checks if the visitor is signed in
      - if not signed in → window.location.assign('/login?next=...')
      - learner signs in → automatically returns to the classroom
    
    The ACCESS_CODE env var must ALSO be deleted from Vercel (and
    .env.local) to stop the upstream middleware + AccessCodeGuard from
    firing. This code change handles the auth redirect; the env delete
    handles the modal suppression. Both are needed.
    
    tsc --noEmit: 0 errors.

 app/classroom/[id]/page.tsx | 31 +++++++++++++++++++++++++++++++
 1 file changed, 31 insertions(+)

commit 30818243c33f047ac8dc021022ab6a2a0e4978aa
Author: Codex <codex@local>
Date:   Sun Jul 12 02:58:46 2026 +0800

    fix(teacher): precise email-collision copy in create-teacher API
    
    Same UX bug as create-student had: when the conflicting email
    belonged to a different role (admin / learner / teacher), the
    API just said '该邮箱已被占用'. Now look up profiles.role and
    return role-specific copy so the admin immediately knows which
    identity owns the email.
    
    Verified with tsc --noEmit: 0 errors.

 app/api/admin/teachers/create/route.ts | 23 ++++++++++++++++++++++-
 1 file changed, 22 insertions(+), 1 deletion(-)

commit 89a755692a02c8a6e54a5c32935b6ca4eca92977
Author: Codex <codex@local>
Date:   Sun Jul 12 02:51:56 2026 +0800

    fix(ts): add 'teacher' to UserRole + cast invite payload to error variant
    
    Two TS errors caught by Vercel build that didn't surface in dev:
    
    1. lib/auth/use-auth.ts: UserRole type was 'admin' | 'learner',
       missing 'teacher'. auth-gate.tsx compared profile.role !==
       'teacher' but TS saw no overlap between the type union and
       'teacher' → TS2367.
    
    2. app/invite/page.tsx: payload is a union of success and error
       variants. TS can't narrow via !('studentName' in payload) so
       payload.error was unreachable on the success branch → TS2339.
       Cast to the error variant explicitly inside the guard.
    
    Verified with tsc --noEmit: 0 errors.

 app/invite/page.tsx  | 9 ++++-----
 lib/auth/use-auth.ts | 2 +-
 2 files changed, 5 insertions(+), 6 deletions(-)

commit 11db21e061d8b3e800ef99b8ebc076a6c2850ccc
Author: Codex <codex@local>
Date:   Sun Jul 12 02:49:12 2026 +0800

    fix(invite): drop errorCode access to satisfy TS union narrowing
    
    Same TS2345 pattern as create-student-form: ERROR_COPY[payload.errorCode]
    accessed errorCode before TS could narrow the union to the error
    variant. Use payload.error directly (which IS available on both
    branches via the 'in' guard) and drop the ERROR_COPY lookup.

 app/invite/page.tsx | 6 +++++-
 1 file changed, 5 insertions(+), 1 deletion(-)

commit d1ee10fe16d79e3c07d01e0db24ad7848665c735
Author: Codex <codex@local>
Date:   Sun Jul 12 02:35:03 2026 +0800

    fix(admin): drop stale access_code from create-student SuccessPayload
    
    Vercel build failed with TS2345:
      'access_code' does not exist in type 'SuccessPayload | ...'
    
    The SuccessPayload interface was narrowed to { email, initial_password }
    when the access_code field was removed from the create-student API
    response, but a stale object literal line
      access_code: data.access_code,
    was left in setSuccess() and the build caught it.
    
    The interface and the call site now agree.

 app/admin/students/_components/create-student-form.tsx | 1 -
 1 file changed, 1 deletion(-)

commit e5b3d562512a92c4de96c0e3e6188af8a26305da
Author: Codex <codex@local>
Date:   Sun Jul 12 02:19:06 2026 +0800

    docs(DEV): redact Supabase service_role key from environment template
    
    The previous commit (16060a4) hardcoded the operator's actual
    SUPABASE_SERVICE_ROLE_KEY into docs/DEV.md as part of the .env.local
    'required env vars' reference. That key is a secret — anyone with
    read access to the repo can use it to bypass every RLS policy on
    the project. GitHub push protection correctly rejected the push.
    
    This commit replaces the actual key value with a <your-supabase-service-role-key>
    placeholder so the doc reads as a template, not a leak. Operators
    fill in their real values locally in .env.local and in Vercel
    env vars; neither path involves the git repository.
    
    Note: this commit fixes the latest copy of DEV.md but the secret is
    still in commit 16060a4's tree. Operators should:
      1. rotate the SUPABASE_SERVICE_ROLE_KEY in Supabase Dashboard
         (treat the existing one as compromised — it was committed)
      2. push this fix commit (force-push after unblock or rebuild
         the repo, see follow-up decision)
    
    TODO: also audit any other docs/*.md / *.sql / *.ts for committed
    secrets and rotate them in their respective vendor dashboards.

 docs/DEV.md | 14 ++++++++------
 1 file changed, 8 insertions(+), 6 deletions(-)

commit 16060a439ae3af6bb759e295e082f6b6c7a6169d
Author: Codex <codex@local>
Date:   Sun Jul 12 02:01:06 2026 +0800

    docs: PRD + DEV hand-off documents
    
    docs/PRD.md — product-side documentation:
    - business context, RJ-laixue vs OPENMAIC upstream differentiation
    - user roles (admin / teacher / learner) + their permissions
    - core flows (create student / learner login / authoring / Pro Mode / share)
    - completed features matrix + known limitations + follow-up roadmap
    - deployment topology, schema patch order, key decisions log
    
    docs/DEV.md — engineering-side documentation:
    - file / directory structure (which dirs are RJ-laixue vs OPENMAIC upstream)
    - files in the upstream tree that we've forked and modified
    - key technical decisions and their rationale:
      - webpack-only dev (Turbopack panics on Windows + pnpm + shiki)
      - createBrowserClient for cookie-based session sharing
      - window.location.assign instead of router.refresh after sign-in
      - cache-busting ?_=timestamp on post-create admin navigation
      - Pro Mode purely URL-gated (?editor=1)
      - seed_admin_email hardcoded in trigger (bypasses set_config+pooling)
      - .next cache eviction on schema / route structure changes
    - required env vars + Vercel mirror
    - schema deployment order (5 SQL files, idempotent)
    - local dev + deployment steps
    - test path checklist (13 steps covering all major flows)
    - debugging tips table
    - hand-off checklist for the next agent
    
    .gitignore: /docs was blanket-ignoring all docs (including our hand-off
    ones). Narrow to /docs/internal/ so docs/PRD.md and docs/DEV.md
    become tracked. Anything private later goes under docs/internal/.

 .gitignore  |   8 ++-
 docs/DEV.md | 213 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 docs/PRD.md | 163 ++++++++++++++++++++++++++++++++++++++++++++++
 3 files changed, 382 insertions(+), 2 deletions(-)

commit ce138bb6079087a491455e3f8ecc3e40e54a5969
Author: Codex <codex@local>
Date:   Sun Jul 12 01:58:44 2026 +0800

    feat(rls): wave 1 SQL — revoke anon write on learning tables
    
    Adds supabase-rls-tighten-wave1.sql which DROPs the 6 anon insert/update
    policies on students / course_assignments / course_progress_events.
    
    Effect:
      - anon key can no longer INSERT or UPDATE any of the three
        learning tables (security boundary established)
      - anon SELECT still works (keeps OPENMAIC upstream read-only
        API paths functional until wave 2 / wave 3 rewire them)
      - service_role bypasses RLS — all RJ-laixue admin APIs (create
        student, create teacher, disable, enable, reset password, unbind,
        delete) keep working unchanged
      - Authenticated learners' reads are unaffected (they only
        SELECT anyway; inserts/updates flow through service_role
        via our server-side routes)
    
    Follow-up waves (planned):
      - wave 2: rewire app/api/courses/[id]/route.ts to service_role
      - wave 3: rewire app/api/courses/route.ts (list / create) to service_role
      - wave 4: rewire app/api/learning/* (progress events) to service_role
      - wave 5: drop the remaining anon SELECT policies
    
    Apply manually:
      1. Supabase Dashboard -> SQL Editor -> New query
      2. Paste contents of supabase-rls-tighten-wave1.sql
      3. Run; expect 'Success. No rows returned' for each DROP and a
         result table showing only SELECT policies remaining.
    
    DO NOT deploy to laixue.work before testing locally first —
    this wave breaks OPENMAIC's authoring save-to-cloud until wave 2.

 supabase-rls-tighten-wave1.sql | 49 ++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 49 insertions(+)

commit 07add04aa2cf4af1b04b2c8c89bab7aa2e5488b7
Author: Codex <codex@local>
Date:   Sun Jul 12 01:22:14 2026 +0800

    fix(playback): strip isMaicEditorEnabled gate + restore share button
    
    Two admin feedback items from manual QA:
    
    1. components/stage.tsx + components/edit/EditChromeRoot.tsx:
       the Pro Mode toggle was gated on isMaicEditorEnabled() ||
       editorAutoOpen. Because the operator's .env.local had
       NEXT_PUBLIC_MAIC_EDITOR_ENABLED=true, every plain /classroom/{id}
       URL (from the cloud-courses '打开' button) still surfaced the
       Pro Mode toggle and 'save to cloud' affordance.
    
       Drop the env-flag term entirely. Pro Mode is now strictly
       URL-gated on ?editor=1. That single change makes '打开' = pure
       playback (the intended learner-facing entry point) and reserves
       '铅笔' (which appends ?editor=1) for the authoring surface.
    
    2. components/cloud-courses.tsx: restore the share button I had
       removed earlier when the share-link flow looked redundant.
       Now that Pro Mode and the share link are decoupled, sharing
       is again useful: '分享' copies  (no
       query string) so a signed-in learner lands in clean playback.
       Added a per-row shareMessage so the admin sees the copy result
       right under the buttons rather than via alert().

 components/cloud-courses.tsx       | 33 +++++++++++++++++++++++++++++++++
 components/edit/EditChromeRoot.tsx |  6 +++---
 components/stage.tsx               | 17 ++++++++---------
 3 files changed, 44 insertions(+), 12 deletions(-)

commit 81801f85dd1a35d232708cf2a5d7ddc7b3a2bea3
Author: Codex <codex@local>
Date:   Sun Jul 12 01:12:13 2026 +0800

    fix(admin): move disable/enable routes under [id]/ + show precise error copy
    
    Two distinct bugs surfaced today:
    
    1. POST /api/admin/students/{studentId}/disable and .../{id}/enable
       used the same one-segment route file path as .../disable and
       .../enable. The directory layout didn't include the [id] segment,
       so Next.js never resolved those URLs (always 404) — which
       surfaced as '网络错误' on the admin roster.
    
       Move app/api/admin/students/disable/route.ts ->
       app/api/admin/students/[id]/disable/route.ts
       Move app/api/admin/students/enable/route.ts ->
       app/api/admin/students/[id]/enable/route.ts
    
       The handler body was already authored to read params.id so no
       body change was needed.
    
    2. CreateStudentForm / CreateTeacherForm caught API errors via
       ERROR_COPY[errorCode] FIRST, ignoring the precise 'error' string
       the server returned. So when the admin tried to reuse
       jinzengquan@ruijie.com.cn (which is an admin profile) the API
       correctly responded '该邮箱已是管理员账号' but the form
       overrode it with the generic '该邮箱已被使用，请换一个'.
    
       Swap the lookup order: prefer data.error, fall back to
       ERROR_COPY[errorCode]. Document the intent in a comment so it
       doesn't get regressed again.

 app/admin/students/_components/create-student-form.tsx | 12 ++++++++++--
 app/admin/teachers/_components/create-teacher-form.tsx |  4 ++--
 app/api/admin/students/{ => [id]}/disable/route.ts     |  0
 app/api/admin/students/{ => [id]}/enable/route.ts      |  0
 4 files changed, 12 insertions(+), 4 deletions(-)

commit d014ef1ff9fa46d0c37fdb4d559f772734a0a050
Author: Codex <codex@local>
Date:   Sun Jul 12 00:25:54 2026 +0800

    fix(classroom): EditChromeRoot hook order + cache-bust post-create nav
    
    Two bugs from the last commit:
    
    1. components/edit/EditChromeRoot.tsx: my previous edit left the
       useSearchParams hook at module scope (no indentation inside the
       function body) and pasted a second copy inside the JSX, which
       webpack's parser correctly refused with a JSX syntax error that
       took down the whole /classroom/[id] page. Move the single hook
       call to the top of the function body alongside the other hooks.
    
    2. CreateStudentForm / CreateTeacherForm '确认' button: pure
       window.location.assign('/admin/students') got intercepted by
       the Next.js client router and the server component returned a
       cached payload from before the create — the new row never showed
       up. Add a cache-busting query param (?_=timestamp) so the browser
       issues a real new GET that bypasses the RSC cache.

 app/admin/students/_components/create-student-form.tsx | 2 +-
 app/admin/teachers/_components/create-teacher-form.tsx | 2 +-
 components/edit/EditChromeRoot.tsx                     | 9 +++++----
 3 files changed, 7 insertions(+), 6 deletions(-)

commit d6cc1da30da7a8ed0d95369d40056e42a3bc0a3f
Author: Codex <codex@local>
Date:   Sun Jul 12 00:08:15 2026 +0800

    fix(classroom): gate Pro Mode and '保存到云端' on URL, not just env flag
    
    Three coordinated changes per admin feedback:
    
    1. components/stage.tsx: Pro Mode toggle is now exposed when
       EITHER NEXT_PUBLIC_MAIC_EDITOR_ENABLED is set OR the URL has
       ?editor=1. The URL path lets an admin / teacher hop from the
       saved-course roster into Pro Mode without needing the
       feature flag to be enabled in production.
    
    2. components/edit/EditChromeRoot.tsx: the same gate is applied
       to the 'exit Pro Mode' button so an admin can also leave
       Pro Mode after entering via the URL.
    
    3. app/classroom/[id]/page.tsx: the '保存到云端' button is now
       also gated by ?editor=1 (in addition to !readOnlyShare &&
       generationComplete). When a learner opens the course via
       /student/courses (no editor=1), the save-to-cloud affordance
       no longer surfaces — there's nothing for a learner to save
       there, and we don't want them to overwrite the teacher's
       saved copy. Authoring tools and Pro Mode both live behind
       the same URL flag so the entry points stay coherent.
    
    Effect on the surface:
      - '打开' button in cloud-courses.tsx → /classroom/{id} (no
        editor=1) → playback, no Pro toggle, no save button.
      - '铅笔' button in app/page.tsx → /classroom/{id}?editor=1
        (new tab) → Pro Mode toggle + save-to-cloud button visible.

 app/classroom/[id]/page.tsx        |  6 ++++--
 components/edit/EditChromeRoot.tsx |  9 ++++++++-
 components/stage.tsx               | 13 ++++++++++++-
 3 files changed, 24 insertions(+), 4 deletions(-)

commit 0b7bdfd39cc0b74b5e9591555cb5ce12fac9202e
Author: Codex <codex@local>
Date:   Sat Jul 11 23:39:52 2026 +0800

    fix(admin): better email-collision copy + force page refresh after create
    
    Three issues from manual QA today:
    
    1. create-student API's EMAIL_TAKEN error used to say '邮箱已被占用'
       with no context. When the conflict was actually a teacher account
       (e.g. laojin@ruijie.com was used as a teacher first), the admin
       had to figure out why. Now we look up the conflicting profile's
       role and surface it explicitly:
         - 'teacher' / 'admin' / 'learner' / 'fallback' messages
       so the admin immediately knows which existing identity owns
       the email.
    
    2. CreateStudentForm / CreateTeacherForm '确认' button used to call
       router.refresh() which is unreliable in Next.js 16 dev mode — the
       roster page can show a stale payload after a successful create.
       Switch to window.location.assign('/admin/students') /
       '/admin/teachers' so the navigation is hard and the server
       component re-runs against fresh data.
    
    3. The cloud-courses.tsx '打开' button was the missing affordance
       once the previous '分享' button was removed (internal training
       no longer needs share-link copy). Opens /classroom/[id] in a
       new tab so admins / teachers can preview their saved courses
       straight from the cloud roster on the home page.
    
    4. app/page.tsx 'Pencil' affordance on a saved course card
       previously called startRename to edit the course title. Per
       feedback, that pencil should jump straight into the MAIC Editor
       (Pro mode) so admins can iterate. Now it opens
       /classroom/{id}?editor=1 in a new tab. The classroom page reads
       the ?editor=1 flag and calls useStageStore.setState({ mode: 'edit' })
       so the user lands in Pro mode without an extra click. The
       MAIC Editor itself is still gated by NEXT_PUBLIC_MAIC_EDITOR_ENABLED
       so this is a no-op when the feature flag is off.

 .../students/_components/create-student-form.tsx   |  9 ++++----
 .../teachers/_components/create-teacher-form.tsx   |  9 ++++----
 app/api/admin/students/create/route.ts             | 27 ++++++++++++++++++++--
 app/classroom/[id]/page.tsx                        | 13 +++++++++++
 app/page.tsx                                       | 14 ++++++++++-
 components/cloud-courses.tsx                       |  6 +++++
 6 files changed, 67 insertions(+), 11 deletions(-)

commit 94192f44bb0bd5a5ef0ef9dccba3a0b237794ea4
Author: Codex <codex@local>
Date:   Sat Jul 11 23:08:28 2026 +0800

    fix(share): drop access_code from learner entry + remove learning-manager UI
    
    Three coordinated changes per admin feedback:
    
    1. app/student/courses/page.tsx: '进入教室' now links to
       /classroom/{id} without ?share=1. With the share parameter gone,
       /classroom/[id]/page.tsx never enters the StudentGate branch —
       any authenticated learner is loaded straight into the playback
       experience. This matches the new contract: 'admin creates the
       account, learner signs in with email + password, learner sees
       the course'. No access_code hand-off required.
    
    2. components/cloud-courses.tsx: drop the '分享' button, the
       '学习管理' button, the related setSharing / setManagingCourseId
       state, the handleShare function, and the <LearningManager/>
       block at the bottom of the grid. Internal-training doesn't need
       share-link copy or per-course access_code administration —
       learners are routed in via the roster flow on /student/courses
       instead.
    
    3. The legacy 'LearnManager' component (components/learning-manager.tsx)
       is left in the repo for now since OPENMAIC upstream still imports
       it elsewhere, but it is no longer reachable from the cloud-courses
       roster UI.

 app/student/courses/page.tsx |  2 +-
 components/cloud-courses.tsx | 45 --------------------------------------------
 2 files changed, 1 insertion(+), 46 deletions(-)

commit 66978b7f6701f8891e8022886bf4d3fc1f55204b
Author: Codex <codex@local>
Date:   Sat Jul 11 18:31:17 2026 +0800

    fix(sql): make role enum + disabled_at migration idempotent
    
    The previous version of this file only ran CREATE TABLE if the
    profiles table didn't exist, so re-running it on an existing
    deployment wouldn't update the check constraint to include
    'teacher' and wouldn't add disabled_at. Move those changes into
    explicit ALTER TABLE statements after the create block so the
    script is safe to re-run on either a fresh or existing project.

 supabase-auth-mvp.sql | 13 +++++++++++--
 1 file changed, 11 insertions(+), 2 deletions(-)

commit 733764696e647581d97083877182f9c13cc6f822
Author: Codex <codex@local>
Date:   Sat Jul 11 18:30:38 2026 +0800

    feat(roles): add teacher role + roster page + drop assignments gate
    
    Profiles now support three roles instead of two:
    
      - admin:    manages students + teachers + sees all courses
      - teacher:  creates / views courses (auth-gate allows admin OR
                  teacher on the authoring home /), but cannot enter
                  /admin/students
      - learner:  views every cloud course at /student/courses
    
    New SQL: profiles.role check constraint widened to include
    'teacher', plus profiles.disabled_at for soft-delete parity
    with students.disabled_at.
    
    New API surface (all admin-only, service-role):
      POST /api/admin/teachers/create            name + email
      POST /api/admin/teachers/reset-password    teacher_id
      POST /api/admin/teachers/disable           teacher_id
      POST /api/admin/teachers/enable            teacher_id
    
    New admin surface:
      /admin/teachers — roster + CreateTeacherForm +
      TeacherActions (same shape as the student row UI).
    
    /student/courses now reads public.courses directly instead of
    joining course_assignments. Every active learner sees every
    cloud course. course_assignments is left in the schema for
    upstream compatibility but is no longer consulted.
    
    components/auth-gate.tsx: AdminGate now lets role='teacher'
    through to the authoring home alongside admin. Learners still
    see the '学习账号已登录' empty card and can sign out.
    
    Admin hub at /admin now shows four cards: 学员管理 / 老师管理 /
    课件管理 / 运营报表.

 app/admin/page.tsx                                 |  18 +-
 .../teachers/_components/create-teacher-form.tsx   | 154 ++++++++++++++++
 app/admin/teachers/_components/teacher-actions.tsx | 201 +++++++++++++++++++++
 app/admin/teachers/page.tsx                        | 141 +++++++++++++++
 app/api/admin/teachers/create/route.ts             | 152 ++++++++++++++++
 app/api/admin/teachers/disable/route.ts            |  91 ++++++++++
 app/api/admin/teachers/enable/route.ts             |  66 +++++++
 app/api/admin/teachers/reset-password/route.ts     |  99 ++++++++++
 app/student/courses/page.tsx                       |  87 ++++-----
 components/auth-gate.tsx                           |   4 +-
 supabase-auth-mvp.sql                              |   3 +-
 11 files changed, 951 insertions(+), 65 deletions(-)

commit 0770f93b9b670c9af616f024d3d7828ec38b646f
Author: Codex <codex@local>
Date:   Sat Jul 11 18:09:24 2026 +0800

    feat(admin): /admin/courses course roster with read-only preview
    
    The /admin hub already had cards for 学员管理 + 课程分配 (placeholder)
    + 运营报表 (placeholder). This wires up 课件管理 (the actual
    viewer of cloud-stored courses) so admins can see every course
    that's been saved to Supabase and click through to /classroom/[id]
    to preview the same playback experience a learner would.
    
    Empty state explicitly tells the admin that courses only appear
    here after they've been '保存到云端' via the existing authoring
    flow — IndexedDB-only courses are not shown, by design.

 app/admin/courses/page.tsx | 134 +++++++++++++++++++++++++++++++++++++++++++++
 app/admin/page.tsx         |  14 +++++
 2 files changed, 148 insertions(+)

commit eb0ebd192d1df836d70a3ce9274cc498984942ed
Author: Codex <codex@local>
Date:   Sat Jul 11 18:01:51 2026 +0800

    fix(admin): drop access_code from create flow + revalidate on success
    
    Three small fixes per admin feedback:
    
    1. Drop access_code from the create-account surface.
       The schema column stays (NOT NULL constraint + DEFAULT generates
       a random 6-char code automatically) so legacy rows are intact,
       but the API no longer accepts it as input, no longer returns it
       to the admin, and the roster no longer renders it.
    
    2. Confirm button label: '我已抄下，关闭' -> '确认'.
    
    3. Roster refresh after create: the previous version relied on
       router.refresh() from the client, which in Next.js 16 dev mode
       sometimes didn't invalidate the RSC payload. The API now also
       calls revalidatePath('/admin/students') so the server component
       re-runs its query on the next request. The data was already
       there — the UI just wasn't showing it.

 .../students/_components/create-student-form.tsx   |  7 +--
 app/admin/students/page.tsx                        | 21 +++----
 app/api/admin/students/create/route.ts             | 72 ++++++++++------------
 3 files changed, 43 insertions(+), 57 deletions(-)

commit 98684c15a57bd379b9f43ca142c1d2a23a8f5b34
Author: Codex <codex@local>
Date:   Sat Jul 11 17:48:42 2026 +0800

    feat(admin): one-shot create-student + soft-disable + learner-side gate
    
    The previous design was off — it assumed students rows existed
    upstream and the admin merely bound auth.users to them. The real
    workflow is: admin types a name + email once and the system
    provisions the full identity. Replace the two-step bind flow
    with a single POST /api/admin/students/create that creates
    auth.users + students + (via trigger) profiles in one round trip.
    
    Soft delete replaces both unbind and hard delete:
      POST /api/admin/students/{id}/disable — sets disabled_at
      POST /api/admin/students/{id}/enable  — clears it
    The students row + auth.users row + course_assignments +
    course_progress_events all stay intact for re-enable.
    
    Roster UI rewritten:
      - top-of-page CreateStudentForm replaces the per-row binding
      - StudentActions (per row) exposes 重置密码 / 禁用-or-启用
    
    The legacy routes are deleted:
      - create-account, unbind, delete
      - their row-level components (create-account-row, bound-row,
        delete-archive-button)
    
    /student/courses now also checks disabled_at and shows an
    账号已停用 card instead of the empty state.
    
    Schema change lives in supabase-students-disabled.sql — run that
    file in the Supabase SQL editor before deploying.

 .../students/_components/create-account-row.tsx    | 161 ----------------
 .../students/_components/create-student-form.tsx   | 166 ++++++++++++++++
 .../students/_components/delete-archive-button.tsx | 123 ------------
 .../{bound-row.tsx => student-actions.tsx}         |  87 +++++----
 app/admin/students/page.tsx                        | 128 +++++++------
 app/api/admin/students/create-account/route.ts     | 193 -------------------
 app/api/admin/students/create/route.ts             | 211 +++++++++++++++++++++
 app/api/admin/students/delete/route.ts             | 121 ------------
 app/api/admin/students/disable/route.ts            |  78 ++++++++
 app/api/admin/students/enable/route.ts             |  62 ++++++
 app/api/admin/students/unbind/route.ts             | 110 -----------
 app/student/courses/page.tsx                       |  23 ++-
 12 files changed, 652 insertions(+), 811 deletions(-)

commit be4ac1cc5e63222d49d486826ef4779b65cb7477
Author: Codex <codex@local>
Date:   Sat Jul 11 17:45:32 2026 +0800

    feat(schema): add students.disabled_at for soft-delete
    
    When an admin clicks '禁用' on /admin/students we set
    disabled_at = now() instead of dropping the student row. The
    /student/courses page gates on disabled_at IS NULL so the learner
    can no longer sign in, while historical assignments + progress
    events remain queryable in case the operator wants to re-enable.
    
    Partial index keeps the active roster query cheap.

 supabase-students-disabled.sql | 20 ++++++++++++++++++++
 1 file changed, 20 insertions(+)

commit 1de4e1606abe7ff610acc54cd7fb412feaf9435d
Author: Codex <codex@local>
Date:   Sat Jul 11 17:38:02 2026 +0800

    fix(create-account-row): open fragment around form + DeleteArchiveButton
    
    The previous commit's Edit placed <DeleteArchiveButton/> as a
    sibling of <form> but didn't open a fragment, which is invalid JSX.
    Wrap both elements in <></> so the component compiles.

 app/admin/students/_components/create-account-row.tsx | 5 +++--
 1 file changed, 3 insertions(+), 2 deletions(-)

commit e77e461dd7082386c701489743038c0974252015
Author: Codex <codex@local>
Date:   Sat Jul 11 17:37:11 2026 +0800

    feat(admin): delete student archive (row + auth.users) from the roster
    
    Unbind clears students.user_id and deletes the auth.users row, but
    the student record itself stays. Admins also need a way to fully
    remove a learner from the platform when they leave or were created
    by mistake.
    
    - POST /api/admin/students/delete: drops the auth.users row (if
      bound) then the students row. Refuses with 403 if the bound user
      has role='admin' as a defensive check.
    - Shared DeleteArchiveButton used by both BoundRow and
      CreateAccountRow so admins can delete a record whether or not the
      learner has a bound login. Two-step confirm: click the button,
      retype the student name to enable the destructive action.

 app/admin/students/_components/bound-row.tsx       |   2 +
 .../students/_components/create-account-row.tsx    |   3 +
 .../students/_components/delete-archive-button.tsx | 123 +++++++++++++++++++++
 app/api/admin/students/delete/route.ts             | 121 ++++++++++++++++++++
 4 files changed, 249 insertions(+)

commit 93f6eee671e7b8ece122337d4625b8b40d3723c7
Author: Codex <codex@local>
Date:   Sat Jul 11 17:25:50 2026 +0800

    fix(admin): keep the initial-password card visible until admin closes it
    
    Both CreateAccountRow and BoundRow called router.refresh() the
    moment the create / reset-password API returned. That unmounted the
    client component, which wiped the once-visible initial password
    before the admin could copy it — they reported it flashing past.
    
    Move router.refresh() to the '我已抄下，关闭' button. The card
    stays put until the admin explicitly closes it, so they have time
    to read the password back and hand it to the learner. The
    '返回管理端' link from the previous commit is unaffected.

 app/admin/students/_components/bound-row.tsx          | 13 +++++++++----
 app/admin/students/_components/create-account-row.tsx | 19 +++++++++++++++++--
 2 files changed, 26 insertions(+), 6 deletions(-)

commit bfc40828295ae3ef5087711220cf3c58ac648bfe
Author: Codex <codex@local>
Date:   Sat Jul 11 17:17:37 2026 +0800

    feat(admin): reset password + unbind controls on bound students
    
    After the admin can provision accounts, the obvious follow-up is
    how to recover when a learner forgets their password or when an
    admin needs to revoke an account. Adds two API routes and an
    inline BoundRow client component:
    
    - POST /api/admin/students/reset-password
      Generates a new 12-char password for the auth.users row bound to
      the student and returns it once for the admin to read back.
    - POST /api/admin/students/unbind
      Detaches the student (students.user_id = NULL) and deletes the
      auth.users row so the email can be reused for a different
      student. Refuses with 403 if the target user has role='admin' so
      an admin cannot unbind themselves by accident.
    - BoundRow renders alongside each bound student with two buttons.
      Reset shows the new password in a once-visible block. Unbind
      asks the admin to type the student's name to confirm so a stray
      click cannot delete an account.
    - Page header link '返回创作首页' is now '返回管理端' and points
      to /admin so admins stay inside the admin shell.

 app/admin/students/_components/bound-row.tsx   | 194 +++++++++++++++++++++++++
 app/admin/students/page.tsx                    |  12 +-
 app/api/admin/students/reset-password/route.ts |  95 ++++++++++++
 app/api/admin/students/unbind/route.ts         | 110 ++++++++++++++
 4 files changed, 406 insertions(+), 5 deletions(-)

commit 7e8365f95fe9a3e68d546af2d14caae0c2e74ba7
Author: Codex <codex@local>
Date:   Sat Jul 11 16:59:43 2026 +0800

    fix(student): redirect admins away from /student/courses
    
    Admins are operators, not learners. They have no student row
    bound to their auth user, so /student/courses used to render the
    "还没绑定学员号" empty card for them — a confusing dead end.
    
    Server-side role check: if the signed-in user's profile.role is
    'admin', redirect to /admin instead. The check happens before the
    student query so the empty card never flashes.

 app/student/courses/page.tsx | 13 +++++++++++++
 1 file changed, 13 insertions(+)

commit 1c129e753c807bf53d0de4774249478ef4076ed3
Author: Codex <codex@local>
Date:   Sat Jul 11 16:52:38 2026 +0800

    fix(auth): use createBrowserClient so the session is cookie-based
    
    The previous lib/supabase/client.ts used @supabase/supabase-js's
    plain createClient, which by default persists the auth session to
    localStorage. Server components and route handlers read cookies
    via next/headers — they never see the localStorage entry — so the
    RSC at /admin always bounced the user back to /login right after
    a successful client signIn.
    
    Switching to createBrowserClient from @supabase/ssr writes the
    session to cookies on the client. Same cookie name as the server
    client, so the next request the browser issues (after
    window.location.assign) carries a session cookie that getUser()
    in the RSC can decode.
    
    This is the missing link that makes the signIn -> /admin redirect
    chain work end to end.

 lib/supabase/client.ts | 28 ++++++++++++++++++++++++++--
 1 file changed, 26 insertions(+), 2 deletions(-)

commit 1b983adf0aaec323b7edbe36f17407bb8c5f3c2a
Author: Codex <codex@local>
Date:   Sat Jul 11 16:32:41 2026 +0800

    fix(auth): force full-page navigation after sign-in
    
    router.replace(next) + router.refresh() was racing the Supabase auth
    cookie write: the very next server request (the RSC at the next
    route) sometimes saw an empty cookie store and bounced the user
    back to /login.
    
    Switching to window.location.assign(next) makes the browser issue a
    brand-new request, so the RSC reads cookies that are guaranteed to
    be in the store. Loses some client-side transition polish but
    fixes the redirect loop for the admin landing flow.

 app/login/page.tsx | 9 +++++++--
 1 file changed, 7 insertions(+), 2 deletions(-)

commit 396ba3ecd05419bd551fd4a6dca4ec68e084df6b
Author: Codex <codex@local>
Date:   Sat Jul 11 16:14:28 2026 +0800

    feat(admin): /admin hub landing page
    
    Adds an /admin route (in addition to /admin/students) so admins
    can navigate by remembering only the prefix. The hub is a minimal
    RSC that gates on profile.role='admin' and renders three cards:
    
    - 学员管理 (active): links to /admin/students
    - 课程分配 (placeholder): for stage-two
    - 运营报表 (placeholder): for stage-two
    
    Non-admin signed-in users are redirected to /student/courses; the
    unauthenticated are sent to /login?next=/admin.

 app/admin/page.tsx | 103 +++++++++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 103 insertions(+)

commit f2bd25e81497f4d4a6e0f487eb53a4347c19fc90
Author: Codex <codex@local>
Date:   Sat Jul 11 16:05:08 2026 +0800

    fix(auth): hardcode seed admin email in trigger body
    
    Supabase routes writes through PgBouncer connection pooling. The
    previous upgrade_seed_admin trigger relied on a session-local GUC
    set by set_config() right before the function was defined, which
    does NOT survive across pooled connections. As a result the
    trigger saw an empty target and never promoted the seed admin
    email to role='admin'.
    
    - Replace the set_config dance with a hardcoded email constant in
      the function body. Future operator email changes mean editing the
      function, which is the right trade-off for an MVP seed policy.
    - The trigger still fires on every new auth.users row, so admins
      can invite additional admins later via the same mechanism by
      extending the in-function whitelist.

 supabase-auth-triggers.sql | 14 ++++++++------
 1 file changed, 8 insertions(+), 6 deletions(-)

commit f8e69cf9825be4c79fed29c0fcd696d925e8fbd1
Author: Codex <codex@local>
Date:   Sat Jul 11 16:05:00 2026 +0800

    docs(invite): clarify that accounts are admin-provisioned
    
    The pre-login copy on /invite?code=XXX used to say 'sign up here'.
    Since accounts are now provisioned by /admin/students, point
    learners to use the email and temporary password their admin
    hands them instead.
    
    - Path 1 (no signed-in user, with code): tells the user to use the
      temporary password from their admin
    - Path 2 still redirects to /student/courses when a learner reaches
      /invite without a code in the URL

 app/invite/page.tsx | 4 ++--
 1 file changed, 2 insertions(+), 2 deletions(-)

commit d0975aab0578fd3949da9c2af940ffd255aaf205
Author: Codex <codex@local>
Date:   Sat Jul 11 16:04:53 2026 +0800

    feat(admin): student management page + create-account API
    
    The platform's learner pool is administered, not self-served. This
    commit adds the MVP admin surface for provisioning accounts and
    binding them to existing student rows.
    
    - app/admin/students/page.tsx (RSC): lists every student, gates on
      profile.role === 'admin', embeds an inline CreateAccountRow for
      each row whose user_id is null, redirects non-admins to
      /student/courses.
    - app/admin/students/_components/create-account-row.tsx (client):
      inline form with email + display_name fields; on success shows
      the generated initial password once so the admin can read it
      back before the row reloads to the bound state.
    - app/api/admin/students/create-account/route.ts: server-side
      validation (auth + admin gate), service-role auth.admin.createUser
      with email_confirm=true so the learner can sign in immediately,
      followed by binding students.user_id to the new auth.users row.
      Detailed 400/401/403/404/409/500 responses with localised copy
      consumed by the client component.
    
    The handle_new_user DB trigger (added in commit f6b4474) is the
    sidekick that fills in the public.profiles row at insert time, so
    this route never touches profiles directly.

 .../students/_components/create-account-row.tsx    | 142 +++++++++++++++
 app/admin/students/page.tsx                        | 131 ++++++++++++++
 app/api/admin/students/create-account/route.ts     | 193 +++++++++++++++++++++
 3 files changed, 466 insertions(+)

commit c3b7de5899464b04ca3a452617ff2d3477e6d7e5
Author: Codex <codex@local>
Date:   Sat Jul 11 16:04:42 2026 +0800

    refactor(auth): remove self-registration from login
    
    The platform is for an internal user pool where accounts are
    provisioned by admins via /admin/students. Self-registration
    through the public login page is no longer the entry path.
    
    - Drop the sign-up tab and signUp handler in app/login/page.tsx
    - Add CardDescription text directing non-admin users to contact
      the training administrator for an account
    - /api/access-codes/redeem and handle_new_user trigger remain so
      the admin-provisioning path still benefits from automatic profile
      creation

 app/login/page.tsx | 76 ++++++++++++++----------------------------------------
 1 file changed, 19 insertions(+), 57 deletions(-)

commit d32aa9ce0f2eb60244b05d5d99dc0cc3231acb4e
Author: Codex Handover <codex-handover@local>
Date:   Fri Jul 10 23:52:15 2026 +0800

    chore(deps): add @supabase/ssr for cookie-aware server clients
    
    Required by lib/supabase/server.ts (getServerSupabase). Old
    @supabase/supabase-js alone cannot read the cookie session on
    the server, which was the root cause of stage-zero 'API doesn't
    know who I am' gaps.
    
    Run 'pnpm install' on the live project to materialise
    node_modules before running 'pnpm build'.

 package.json   |  9 +++++----
 pnpm-lock.yaml | 26 +++++++++++++++++++++++---
 2 files changed, 28 insertions(+), 7 deletions(-)

commit f30b64afdf2f32529af26ed9b6c0b76f66e899d9
Author: Codex Handover <codex-handover@local>
Date:   Fri Jul 10 23:40:56 2026 +0800

    feat(auth): /student/courses shows assigned courses for the learner
    
    Server-rendered learner landing page (RSC). Resolves the signed-in
    Supabase Auth user to a student row via students.user_id, then lists
    their course_assignments with status, dates, and a 'copy share link'
    button. Falls back to an empty state when the user has no student
    binding yet, and links them back to /invite to redeem an access code.
    
    Uses getServiceSupabase() instead of the cookie-bound client because
    learning tables currently ship with anon-key RLS — service-role keeps
    the read on the trusted server side until stage two tightens policies
    to authenticated-only. The Button onClick uses navigator.clipboard
    so it never sends the courseId to the server unnecessarily.
    
    Does NOT touch app/classroom/[id] intentionally. Stage two will
    extend the classroom route to accept an auth-user-bound student, so
    the share-link + StudentGate flow remains the default. Course titles
    are intentionally NOT shown because the schema deliberately drops the
    hard FK to courses; the roadmap and stage-two admin tools will
    resolve titles from the existing cloud storage once wired.

 app/student/courses/page.tsx | 190 +++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 190 insertions(+)

commit d99d963d568c3c5edae3ffce390c2a2790f05fe7
Author: Codex Handover <codex-handover@local>
Date:   Fri Jul 10 23:40:19 2026 +0800

    feat(auth): /invite binds a signed-in user to a student access_code
    
    Three UI states:
    
    1. Unauthenticated: links the user to /login?next=/invite?code=...
       so the redemption step resumes after sign in / sign up.
    2. Authenticated but no code in the URL: links back to
       /student/courses so the user can browse their assignments.
    3. Authenticated with a code: shows the access code and a
       confirmation button that POSTs to /api/access-code/redeem
       and routes them to /student/courses on success, otherwise
       shows a localised error per errorCode from the API.
    
    The page intentionally does NOT pre-flight 'is this code valid?'
    to avoid trusting the browser with the service-role privileges;
    only the redemption API does the trusted lookup.

 app/invite/page.tsx | 158 ++++++++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 158 insertions(+)

commit 74563ac717144454370cdc3ee5f17ac8b315ea37
Author: Codex Handover <codex-handover@local>
Date:   Fri Jul 10 23:39:38 2026 +0800

    feat(auth): POST /api/access-code/redeem
    
    Binds the signed-in Supabase Auth user to a student row keyed by
    its 6-character access_code. After this call the caller appears as
    the student in students.user_id, which is what /student/courses
    and future /api/admin/* queries will key off.
    
    - Auth check via getServerSupabase() to read the cookie session.
    - Read + update via getServiceSupabase() so the redemption write
      remains owned by the server even while learning tables still ship
      with anon-key RLS (stage two will move this responsibility into a
      Postgres function under RLS).
    - Idempotent: redeeming the same code twice returns alreadyBound=true.
    - Returns typed 400/401/404/409/500 with consistent error code names
      so /invite can render Chinese messages per code.

 app/api/access-code/redeem/route.ts | 158 ++++++++++++++++++++++++++++++++++++
 1 file changed, 158 insertions(+)

commit e5e62ab2615e0e5d7fe9bcdac6eb6e7d2c7acc51
Author: Codex Handover <codex-handover@local>
Date:   Fri Jul 10 23:38:50 2026 +0800

    refactor(auth): use top-level createClient import for service-role client

 lib/supabase/server.ts | 10 +++++-----
 1 file changed, 5 insertions(+), 5 deletions(-)

commit 42e067ac870bee688bb937ab96053f884ed61b68
Author: Codex Handover <codex-handover@local>
Date:   Fri Jul 10 23:38:25 2026 +0800

    feat(auth): server-side supabase clients (cookie + service_role)
    
    Two new helpers in lib/supabase/server.ts that the rest of the
    account-system patches depend on:
    
    - getServerSupabase(): per-request, cookie-bound client using
      NEXT_PUBLIC_SUPABASE_ANON_KEY. Resolves the server-side mystery
      of 'who am I logged in as' so route handlers and RSC can authorise
      against profiles / students / assignments via RLS.
    - getServiceSupabase(): service-role bypass client using
      SUPABASE_SERVICE_ROLE_KEY. Reserved for /api/admin/* and trusted
      redemption flows. Editor- and bundle-aware: it cannot leak to the
      browser because the env var never has NEXT_PUBLIC_ prefix.
    
    Both clients throw clearly when their env vars are missing so
    local boot failures are loud, not silent.

 lib/supabase/server.ts | 96 ++++++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 96 insertions(+)

commit 45dc75a78c285f98cffd31eea3842050cefff873
Author: Codex Handover <codex-handover@local>
Date:   Fri Jul 10 23:38:01 2026 +0800

    refactor(auth): rely on DB trigger for profile creation
    
    Removes the client-side lazy profile insert. The handle_new_user
    DB trigger (added in the previous commit) is now the single source
    of truth for creating public.profiles rows on signUp.
    
    - ensureProfile() rewritten as fetchProfile(): pure SELECT,
      returns null if the row is not yet visible (e.g. trigger
      propagation lag).
    - loadSession() now treats a missing profile as a valid state
      instead of attempting to insert. onAuthStateChange will retry
      shortly and the UI will surface an 'account provisioning' state.

 lib/auth/use-auth.ts | 29 +++++++++++------------------
 1 file changed, 11 insertions(+), 18 deletions(-)

commit f6b4474c2b7c076262ed7e8da2d5a5678b46f060
Author: Codex Handover <codex-handover@local>
Date:   Fri Jul 10 23:37:33 2026 +0800

    feat(auth): add handle_new_user and upgrade_seed_admin triggers
    
    Stage-one account-system patch. Run AFTER supabase-auth-mvp.sql
    and supabase-learning-mvp.sql. Idempotent.
    
    - handle_new_user trigger: every signUp auto-creates a public.profiles
      row (role='learner', display_name from email prefix or metadata).
      Replaces the race-prone client-side lazy insert in useAuth.
    - upgrade_seed_admin trigger: the operator seed email
      (default: jinzengquan@ruijie.com.cn) is auto-promoted to role='admin'.
      Change the constant in the function body to your own email.
    - Both triggers are SECURITY DEFINER scoped to public.* to keep
      RLS policies on profiles untouched.

 supabase-auth-triggers.sql | 97 ++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 97 insertions(+)

commit 8850b015c43011da5d45c1b93c2a2e26e947b352
Author: Codex <codex@local>
Date:   Fri Jul 10 20:18:39 2026 +0800

    feat: add auth role foundation

 app/login/page.tsx       | 144 +++++++++++++++++++++++++++++++++++++++++++++++
 app/page.tsx             |   7 ++-
 components/auth-gate.tsx |  50 ++++++++++++++++
 lib/auth/use-auth.ts     | 105 ++++++++++++++++++++++++++++++++++
 supabase-auth-mvp.sql    |  54 ++++++++++++++++++
 5 files changed, 359 insertions(+), 1 deletion(-)

commit b91967e1d64035ea26231d4172dfa97cdda953ba
Author: Codex <codex@local>
Date:   Fri Jul 10 19:35:30 2026 +0800

    fix: expose token plan model lists

 lib/server/provider-config.ts | 15 ++++++++++-----
 1 file changed, 10 insertions(+), 5 deletions(-)

commit a31cdc9d379a831b6654303b2a737eebb3e171d5
Author: Codex <codex@local>
Date:   Fri Jul 10 16:42:29 2026 +0800

    feat: support server-managed token plan

 app/api/server-providers/route.ts            |  2 +
 components/generation/generation-toolbar.tsx | 13 ++++
 components/settings/token-plan-settings.tsx  | 18 ++++--
 lib/server/provider-config.ts                | 95 +++++++++++++++++++++++++++-
 lib/store/settings-validation.ts             | 24 +++++--
 lib/store/settings.ts                        |  1 +
 6 files changed, 140 insertions(+), 13 deletions(-)

commit f856ee35760851dad1583993a03f018ebf2e2d69
Author: Codex <codex@local>
Date:   Fri Jul 10 15:52:30 2026 +0800

    fix: recognize server provider without explicit model list

 lib/store/settings.ts | 45 ++++++++++++++++++++++++++++++---------------
 1 file changed, 30 insertions(+), 15 deletions(-)

commit 46b3c1eba54022cc104b7428822783c16dd01294
Author: Codex <codex@local>
Date:   Fri Jul 10 12:22:37 2026 +0800

    fix: resolve cloud sync scene type mismatch

 lib/utils/cloud-sync.ts | 4 ++--
 1 file changed, 2 insertions(+), 2 deletions(-)

commit 60160207dbeca15743ebe3a36712c5a3e87132d4
Merge: 168467da 39beebf5
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Fri Jul 10 12:11:38 2026 +0800

    Merge pull request #2 from zquanjin-wq/fix-publish-local-audio-url
    
    feat: publish local speech audio assets when saving course to cloud

commit 39beebf53153a037389615c6858f1fcb515fb6d5
Author: Codex <codex@local>
Date:   Fri Jul 10 11:58:07 2026 +0800

    docs: record audio cloud publish implementation

 docs/audio-cloud-publish-log.md | 834 ++++++++++++++++++++++++++++++++++++++++
 1 file changed, 834 insertions(+)

commit 4fffd08257af6724b7e6fd86e1ef6183c637dd7a
Author: Codex <codex@local>
Date:   Fri Jul 10 11:48:13 2026 +0800

    feat: publish local speech audio assets when saving course to cloud

 app/api/audio-upload/route.ts |  90 +++++++++++++------
 lib/audio/audio-publish.ts    | 202 ++++++++++++++++++++++++++++++++++++++++++
 lib/utils/cloud-sync.ts       |  66 +++++++++++---
 3 files changed, 320 insertions(+), 38 deletions(-)

commit 168467dac883ac98cd3774d5ee330d6276a26cb6
Merge: 616d6204 18e768ed
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Fri Jul 10 09:22:01 2026 +0800

    Merge pull request #1 from zquanjin-wq/fix-cloud-audio-share
    
    fix: avoid duplicate TTS generation when saving courses

commit 18e768ed0e0245685fb24b4db042f4026614de21
Author: Codex <codex@local>
Date:   Fri Jul 10 03:17:36 2026 +0800

    fix: avoid duplicate TTS generation when saving courses

 app/api/audio-upload/route.ts            | 106 ++++++++++++++++++++++++
 app/api/courses/route.ts                 |  54 +++++++++++--
 app/classroom/[id]/page.tsx              |  56 +++++++++----
 lib/server/classroom-media-generation.ts | 134 +++++++++++++++++++++++++++----
 lib/utils/cloud-sync.ts                  |  30 ++++---
 5 files changed, 331 insertions(+), 49 deletions(-)

commit 616d62043d9dd33d2e25948bba9e40c83d222719
Author: Codex <codex@local>
Date:   Thu Jul 9 15:31:44 2026 +0800

    fix: preserve generated agent names and hydrate agents on cloud course load

 app/classroom/[id]/page.tsx         |  6 ++++++
 lib/orchestration/registry/store.ts | 11 +++++++----
 2 files changed, 13 insertions(+), 4 deletions(-)

commit 7adf83fa67f88e27f16f282ba9d3dd672ac996c5
Author: Codex <codex@local>
Date:   Thu Jul 9 14:24:33 2026 +0800

    fix: localize all 6 agent persona descriptions to Chinese

 lib/orchestration/registry/store.ts | 110 ++++++++++++++++++------------------
 1 file changed, 56 insertions(+), 54 deletions(-)

commit 040da9428fb109859c09c9425578b53d4f2ebd5e
Author: Codex <codex@local>
Date:   Thu Jul 9 14:03:26 2026 +0800

    fix: Chinese agent names and auto-enable TTS for learner view

 components/edit/PlaybackChromeRoot.tsx | 8 ++++++++
 lib/orchestration/registry/store.ts    | 2 +-
 2 files changed, 9 insertions(+), 1 deletion(-)

commit 37409dd19abde936a7b90dbef56c726cf355ef79
Author: Codex <codex@local>
Date:   Thu Jul 9 13:48:31 2026 +0800

    fix: localize StudentGate to Chinese

 components/student-gate.tsx | 14 +++++++-------
 1 file changed, 7 insertions(+), 7 deletions(-)

commit bc11f9c01606073820a07a54f610fcfbf2a4f308
Author: Codex <codex@local>
Date:   Thu Jul 9 13:36:19 2026 +0800

    fix: add RLS policies for learning tables

 supabase-learning-mvp.sql | 16 ++++++++++++++++
 1 file changed, 16 insertions(+)

commit 79bb20a53373c9ad828057881c69cb716302d2d8
Author: Codex <codex@local>
Date:   Thu Jul 9 13:21:09 2026 +0800

    fix: surface learning errors and backfill student access codes

 components/learning-manager.tsx | 12 +++++++++---
 lib/server/learning-mvp.ts      | 15 ++++++++++++++-
 supabase-learning-mvp.sql       | 10 ++++++++++
 3 files changed, 33 insertions(+), 4 deletions(-)

commit c4fc81d5cfedf0ad3521a0754048a16a9dcb4b2f
Author: Codex <codex@local>
Date:   Thu Jul 9 12:29:22 2026 +0800

    chore: update laixue logos and favicon

 app/apple-icon.png         | Bin 24341 -> 50535 bytes
 app/favicon.ico            | Bin 7482 -> 4914 bytes
 app/layout.tsx             |   4 ++++
 assets/logo-horizontal.png | Bin 147781 -> 379133 bytes
 public/logo-horizontal.png | Bin 95897 -> 305546 bytes
 5 files changed, 4 insertions(+)

commit 054fbefb167cdbea2c483a3f2e97faefb091b539
Author: Codex <codex@local>
Date:   Thu Jul 9 12:11:42 2026 +0800

    fix: add access_code to StudentRecord type

 lib/utils/cloud-sync.ts | 1 +
 1 file changed, 1 insertion(+)

commit 3d57c9d0be8edf67e54f42ea1a7d139947701ae9
Author: Codex <codex@local>
Date:   Thu Jul 9 11:58:26 2026 +0800

    feat: add student access code gate for shared courses
    
    - Add access_code column to students table (auto-generated 6-char code)
    - Add /api/learning/verify endpoint to validate student access
    - Add StudentGate component: learners enter access code before viewing
    - Classroom page shows gate in share mode until student verifies
    - Learning manager shows access_code column and updated share flow
    - Learning events now use verifiedStudentId instead of URL param

 app/api/learning/verify/route.ts | 24 ++++++++++++++
 app/classroom/[id]/page.tsx      | 31 ++++++++++++++----
 components/learning-manager.tsx  |  8 +++--
 components/student-gate.tsx      | 71 ++++++++++++++++++++++++++++++++++++++++
 lib/server/learning-mvp.ts       | 29 +++++++++++++---
 lib/utils/cloud-sync.ts          |  9 +++++
 supabase-learning-mvp.sql        |  4 +++
 7 files changed, 164 insertions(+), 12 deletions(-)

commit d207c79365d2a25afe21f28f40147b0c80002d6f
Author: Codex <codex@local>
Date:   Thu Jul 9 11:00:01 2026 +0800

    fix: relax learning mvp schema course references

 supabase-learning-mvp.sql | 6 ++++--
 1 file changed, 4 insertions(+), 2 deletions(-)

commit 073c4c0f2e9270c1ba44cbb8007c7872b1d01efa
Author: Codex <codex@local>
Date:   Thu Jul 9 10:43:10 2026 +0800

    feat: add learning management mvp

 app/api/courses/[id]/assignments/route.ts |  40 ++++
 app/api/learning/events/route.ts          |  43 +++++
 app/api/students/route.ts                 |  34 ++++
 app/classroom/[id]/page.tsx               |  77 +++++++-
 components/cloud-courses.tsx              |  21 ++
 components/learning-manager.tsx           | 311 ++++++++++++++++++++++++++++++
 lib/server/learning-mvp.ts                | 193 ++++++++++++++++++
 lib/utils/cloud-sync.ts                   |  98 ++++++++++
 middleware.ts                             |   8 +-
 supabase-learning-mvp.sql                 |  81 ++++++++
 10 files changed, 904 insertions(+), 2 deletions(-)

commit 6cdade533059aa0a2be33775cfa73015cfabc0db
Author: Codex <codex@local>
Date:   Thu Jul 9 10:20:31 2026 +0800

    fix: show cloud save only after generation

 app/classroom/[id]/page.tsx | 3 ++-
 1 file changed, 2 insertions(+), 1 deletion(-)

commit b952e9a4dc0c1aa370853a51dbac7d8502c0613e
Author: Codex <codex@local>
Date:   Thu Jul 9 09:48:42 2026 +0800

    fix: hide authoring controls in shared courses

 app/classroom/[id]/page.tsx            | 36 +++++++++++++++++++---------------
 components/cloud-courses.tsx           |  2 +-
 components/edit/PlaybackChromeRoot.tsx | 12 ++++++++++--
 components/header.tsx                  | 34 +++++++++++++++++++++++---------
 components/stage.tsx                   | 17 ++++++++++------
 components/stage/header-controls.tsx   |  4 +++-
 6 files changed, 70 insertions(+), 35 deletions(-)

commit b52a14bd30d57f48b98e4ef79bf7cec3ab02ad13
Author: Codex <codex@local>
Date:   Thu Jul 9 09:08:29 2026 +0800

    fix: share cloud courses and preserve title

 components/cloud-courses.tsx | 43 +++++++++++++++++++++++++------------------
 lib/utils/cloud-sync.ts      |  5 +++--
 2 files changed, 28 insertions(+), 20 deletions(-)

commit f6d322d104b74dbaebcd3cdf41bbbeb11822f56f
Author: Codex <codex@local>
Date:   Thu Jul 9 08:36:56 2026 +0800

    docs: outline learning account sharing roadmap

 community/learning-account-and-sharing-roadmap.md | 208 ++++++++++++++++++++++
 1 file changed, 208 insertions(+)

commit 042fe70bc480122f3ef71f9053c92258db794785
Author: Codex <codex@local>
Date:   Wed Jul 8 18:09:30 2026 +0800

    fix: reduce scene content payload size

 app/classroom/[id]/page.tsx      |   5 +-
 lib/hooks/use-scene-generator.ts | 116 ++++++++++++++++++++++++++++++++++++---
 2 files changed, 112 insertions(+), 9 deletions(-)

commit 95f64e591e7726b2b7e88dca932fd4994ed003a3
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Wed Jul 8 15:50:03 2026 +0800

    Update route.ts

 app/api/generate/scene-content/route.ts | 5 +++++
 1 file changed, 5 insertions(+)

commit fddd70f32a01957d2a4d47868ea0d7fdc9a631bd
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Wed Jul 8 15:38:53 2026 +0800

    Update route.ts

 app/api/generate/scene-content/route.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

commit 3816fd771a4b1d45c3f8752b8fcb157f89a3e8ce
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Wed Jul 8 15:31:10 2026 +0800

    Update route.ts

 app/api/generate/scene-content/route.ts | 7 +++----
 1 file changed, 3 insertions(+), 4 deletions(-)

commit d3a74cc3d58b2a5a97c815d304fa22c14eb6f4dd
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Wed Jul 8 15:19:10 2026 +0800

    Update route.ts

 app/api/generate/scene-content/route.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

commit a724c5e6bb9d6db48f013d908602161f023b21c8
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Wed Jul 8 15:14:40 2026 +0800

    Update route.ts

 app/api/generate/scene-content/route.ts | 16 +++++++++++++++-
 1 file changed, 15 insertions(+), 1 deletion(-)

commit 885dab00aa8e0f2821fb6b2b27bdd53bed860f29
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Wed Jul 8 15:08:21 2026 +0800

    Update route.ts

 app/api/generate/scene-outlines-stream/route.ts | 10 +++++++++-
 1 file changed, 9 insertions(+), 1 deletion(-)

commit c76ea3dbb46a55a90627e61d275349a26ab108d6
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Wed Jul 8 11:52:02 2026 +0800

    Update page.tsx

 app/generation-preview/page.tsx | 3 ++-
 1 file changed, 2 insertions(+), 1 deletion(-)

commit 61f634dcb519614c81d10331e5995f6007c16715
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Wed Jul 8 11:38:38 2026 +0800

    Update image-storage.ts

 lib/utils/image-storage.ts | 54 ++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 54 insertions(+)

commit 24f0ff920acb05ae69dea3fa43b3e9d511ff3f4f
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Wed Jul 8 10:23:30 2026 +0800

    Update cloud-sync.ts

 lib/utils/cloud-sync.ts | 6 +++---
 1 file changed, 3 insertions(+), 3 deletions(-)

commit ca0928c29c3026b0acc5b614dac8f0d7f21d0eae
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Wed Jul 8 10:12:20 2026 +0800

    Update middleware.ts

 middleware.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

commit 3e8340686e5bb86535e764cded53ba3975e8e131
Author: zquanjin-wq <jinzengquan@ruijie.com.cn>
Date:   Wed Jul 8 09:38:12 2026 +0800

    fix: disable frozen-lockfile via .npmrc

 .npmrc | 1 +
 1 file changed, 1 insertion(+)

commit 3e88acc36395ca6ebac39825471aca8cf335f1b5
Author: zquanjin <zquanjin@zquanjindeMac-mini.local>
Date:   Wed Jul 8 06:01:41 2026 +0800

    update pnpm-lock.yaml

 pnpm-lock.yaml | 83 +++++++++++++++++++++++++++++++++++++++++++++++++++++-----
 1 file changed, 77 insertions(+), 6 deletions(-)

commit d23b41a2aedfc130a5f1b518e52b9879f8337612
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Wed Jul 8 00:02:00 2026 +0800

    Update vercel.json

 vercel.json | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

commit 3499fe049cfe0e232a357476e2ed312c88141b17
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 23:49:24 2026 +0800

    Update vercel.json

 vercel.json | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

commit 8045290d2df7c462b24ad912fad2dac7d4eff280
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 23:44:28 2026 +0800

    Update vercel.json

 vercel.json | 6 +++---
 1 file changed, 3 insertions(+), 3 deletions(-)

commit 1c4dc651f63d757e5e47a961e22a9615d16e22e3
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 23:41:50 2026 +0800

    Update vercel.json

 vercel.json | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

commit 9782c25c3844ae9b2b1b5a5e3c221d17b4dcf25f
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 23:34:17 2026 +0800

    Update vercel.json

 vercel.json | 4 ++--
 1 file changed, 2 insertions(+), 2 deletions(-)

commit dc30972b1de97844fe3400758649de1398086a82
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 23:29:59 2026 +0800

    Update page.tsx

 app/classroom/[id]/page.tsx | 19 ++++++++++++++++++-
 1 file changed, 18 insertions(+), 1 deletion(-)

commit bd55a9c579e46835356fcf0a3464f6f665955cdc
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 23:03:18 2026 +0800

    Update page.tsx

 app/page.tsx | 4 +++-
 1 file changed, 3 insertions(+), 1 deletion(-)

commit 82b18ab2a45c833c4b1278d087d01b1bbaf6b12b
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 23:00:31 2026 +0800

    Update middleware.ts

 middleware.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

commit c4e297f6ce451d22e5bac85cd1e4e9637b05632c
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 22:57:38 2026 +0800

    Create cloud-courses.tsx

 components/cloud-courses.tsx | 108 +++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 108 insertions(+)

commit 6cbedc207da00e5cdbc588c0a1216991b2c6a551
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 22:55:17 2026 +0800

    Create route.ts

 app/api/courses/[id]/route.ts | 48 +++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 48 insertions(+)

commit adff7ce98c61f1d1f54d47a015cc99d905b336b7
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 22:53:57 2026 +0800

    Create route.ts

 app/api/courses/route.ts | 48 ++++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 48 insertions(+)

commit cb64b5c70c7ec22e3f97df9213da16b45a99d5b4
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 22:49:41 2026 +0800

    Create cloud-sync.ts

 lib/utils/cloud-sync.ts | 82 +++++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 82 insertions(+)

commit f7ecf54274a22e91726b14e7b1bbe4d815bbde7d
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 22:47:57 2026 +0800

    Create client.ts

 lib/supabase/client.ts | 4 ++++
 1 file changed, 4 insertions(+)

commit 563be70aa3adca7bd4d5934a1047214f146ca899
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 22:39:36 2026 +0800

    Update package.json

 package.json | 1 +
 1 file changed, 1 insertion(+)

commit f79f254790fe83caa4f0d36c05f1574f3d9f77dc
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 17:35:23 2026 +0800

    Update middleware.ts

 middleware.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

commit 4025a88b42c5b395cd368cb048f98c3f2c923f60
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 11:50:08 2026 +0800

    Delete public/old.png

 public/old.png | Bin 15366 -> 0 bytes
 1 file changed, 0 insertions(+), 0 deletions(-)

commit c7600953f729dab57719130fbf63cfe099e8eb6b
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 11:47:51 2026 +0800

    Add files via upload

 public/logo-horizontal.png | Bin 0 -> 95897 bytes
 1 file changed, 0 insertions(+), 0 deletions(-)

commit 28dc21c661158f16107730ef767b126e15956f56
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 11:47:30 2026 +0800

    Delete public/logo-horizontal.png

 public/logo-horizontal.png | Bin 147781 -> 0 bytes
 1 file changed, 0 insertions(+), 0 deletions(-)

commit ef8af4144a16612391d05d01561f2e9ef2b1b1b5
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 11:22:48 2026 +0800

    Update layout.tsx

 app/layout.tsx | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

commit c63dcde33dcab52ffd5a1f20706d9b945c6ba5ff
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 11:15:58 2026 +0800

    Update layout.tsx

 app/layout.tsx | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

commit a03292e55bde15712b88fb04ab56090507239066
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 11:13:46 2026 +0800

    Rename ruijiedaxue-logo.png to openmaic-mark.png

 public/{ruijiedaxue-logo.png => openmaic-mark.png} | Bin
 1 file changed, 0 insertions(+), 0 deletions(-)

commit ec03e466721af3984469d6ed767110489daed27e
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 11:13:28 2026 +0800

    Rename openmaic-mark.png to old.png

 public/{openmaic-mark.png => old.png} | Bin
 1 file changed, 0 insertions(+), 0 deletions(-)

commit 4a2eebd7d3f82addc4a468fabebd29827c327f49
Author: zquanjin-wq <zquanjin@gmail.com>
Date:   Tue Jul 7 11:08:43 2026 +0800

    Add files via upload

 public/ruijiedaxue-logo.png | Bin 0 -> 192836 bytes
 1 file changed, 0 insertions(+), 0 deletions(-)

commit 04b70f0359ebb117deeb5e1a0f71b78eb269bc8f
Author: wyuc <wang-yc24@mails.tsinghua.edu.cn>
Date:   Mon Jul 6 05:12:10 2026 -0400

    feat(storage): scaffold @openmaic/storage — KV + asset primitives (browser) (#857) (#858)
    
    * feat(storage): scaffold @openmaic/storage — KV + asset primitives (browser) (#857)
    
    First executable slice of the @openmaic/storage RFC (#779, Part 1): a pure,
    app-agnostic persistence package depending only on @openmaic/dsl.
    
    - Add the DSL-owned `StorageProvider` asset seam to @openmaic/dsl
      (put(blob)->ref / resolve(ref)->url / remove), typed against a structural
      `BinaryBlob` so the pure DSL keeps `lib: ES2022` (no DOM).
    - `KVStore` (device/account scopes) + `BrowserKVStore` over localStorage.
    - `BrowserAssetProvider`: content-addressed (sha256) bytes in IndexedDB,
      resolved to object URLs; identical bytes de-duplicate.
    - `kvPersistStorage`: adapt a KVStore into a zustand `persist` storage
      (pure util; app store wiring is a follow-up).
    - Implementation-agnostic contract suites (KV + StorageProvider), run against
      the browser backends so future backends prove equivalence.
    - Machine-enforce the package import boundary in eslint (no `@/...`),
      mirroring the @openmaic/renderer boundary.
    
    Backends take their Storage/IDBFactory by injection, so the package is
    testable without a browser. Deferred to later Part-1 steps: wiring the app's
    zustand stores + ad-hoc localStorage through KVStore (needs a legacy-key
    compat migration), DocumentStore/RuntimeStore, and the HTTP backend.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * fix(storage): address cross-review findings
    
    - BrowserAssetProvider: resolve writes on transaction.oncomplete (not
      request.onsuccess) so a commit-time abort (e.g. QuotaExceeded) can't be
      reported as durable success.
    - BrowserAssetProvider.openDb: don't memoize a rejected open — a transient IDB
      failure no longer bricks the provider; the next call retries.
    - BrowserAssetProvider.resolve: memoize the resolution per ref so concurrent
      resolves share one object URL instead of orphaning a second one.
    - BrowserKVStore.set: treat a value JSON can't represent (undefined / function
      / symbol) as a removal, instead of writing a literal "undefined" that throws
      on the next get (and would reject zustand rehydration).
    - Tests: build contract Blobs from strings (a Uint8Array BlobPart fails the
      root tsconfig typecheck under TS 5.7+ typed-array generics); reset the
      object-URL registry per test; add regression tests for set(undefined),
      concurrent-resolve, and actual de-dup (one stored row).
    - Drop @openmaic/storage from the root postinstall build chain: nothing imports
      it yet, so building it on every install added latency and coupled its build
      failures to importer/renderer/sync. It re-joins when the app consumes it.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * fix(storage): don't cache a rejected resolve promise
    
    Second cross-review pass caught that the per-ref resolve memoization
    reintroduced the same rejected-promise-caching bug just fixed in openDb: a
    transient IndexedDB failure inside resolve() left the rejected promise in the
    `urls` map, so every later resolve(ref) replayed the rejection and never
    retried. Evict the entry on rejection (mirroring the null-miss path), and add
    a regression test that fails a resolve's IDB open once and asserts the next
    resolve recovers.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * fix(storage): review — coherent re-put contentType + restore bootstrap build
    
    Addresses @cosarah's review on #858:
    
    - BrowserAssetProvider.put: invalidate (revoke + drop) any cached object URL
      for the ref after a write, so a re-put of the same bytes with a corrected
      contentType is reflected by resolve() instead of a stale, cache-warmth-
      dependent MIME type. remove() reuses the same invalidateUrl helper. Adds a
      regression test (put type="" -> resolve -> put same bytes type="image/png"
      -> resolve now reports image/png).
    - Restore @openmaic/storage to the root postinstall build chain: the package
      publishes dist/*, so a clean install must build it or workspace consumers
      resolving it via exports would fail until a manual --filter build.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    ---------
    
    Co-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

 eslint.config.mjs                                  |  24 ++++
 package.json                                       |   2 +-
 packages/@openmaic/dsl/src/index.ts                |   1 +
 packages/@openmaic/dsl/src/storage.ts              |  61 +++++++++
 packages/@openmaic/storage/.gitignore              |   5 +
 packages/@openmaic/storage/LICENSE                 |  21 +++
 packages/@openmaic/storage/README.md               |  60 +++++++++
 packages/@openmaic/storage/package.json            |  55 ++++++++
 packages/@openmaic/storage/src/asset/browser.ts    | 142 +++++++++++++++++++++
 packages/@openmaic/storage/src/index.ts            |  27 ++++
 packages/@openmaic/storage/src/kv/browser.ts       |  74 +++++++++++
 packages/@openmaic/storage/src/kv/types.ts         |  23 ++++
 packages/@openmaic/storage/src/zustand/persist.ts  |  43 +++++++
 .../@openmaic/storage/test/asset-browser.test.ts   |  78 +++++++++++
 packages/@openmaic/storage/test/asset-contract.ts  |  74 +++++++++++
 packages/@openmaic/storage/test/kv-browser.test.ts |   5 +
 packages/@openmaic/storage/test/kv-contract.ts     |  92 +++++++++++++
 .../@openmaic/storage/test/persist-adapter.test.ts |  42 ++++++
 packages/@openmaic/storage/test/setup.ts           |  68 ++++++++++
 packages/@openmaic/storage/tsconfig.json           |  23 ++++
 packages/@openmaic/storage/vitest.config.ts        |  24 ++++
 pnpm-lock.yaml                                     |  43 ++++---
 22 files changed, 971 insertions(+), 16 deletions(-)

commit 1f187ed85fa1f3add2216b74c6cbbca675bfe084
Author: wyuc <wang-yc24@mails.tsinghua.edu.cn>
Date:   Mon Jul 6 01:34:04 2026 -0400

    chore(renderer): machine-enforce the @openmaic/renderer import boundary (#853)
    
    * chore(renderer): enforce package import boundary in lint
    
    Add a files-scoped no-restricted-imports rule for
    packages/@openmaic/renderer/** that bans host-app imports via the `@/…`
    path alias. The package depends only on @openmaic/dsl and its declared
    peers; host concerns (document/undo ownership, media resolution, i18n,
    hotkeys) are injected via props/callbacks.
    
    This is the machine-enforced counterpart of the renderer v2 editing-surface
    boundary (#720 Phase 3, scoped in #851): a deadline can't punch a
    "temporary" store dependency through the package API later. The package
    imports zero `@/…` today, so the rule is purely additive and is enforced by
    the existing `pnpm lint` CI step.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * chore(renderer): also block dynamic `@/` import and require in the boundary
    
    An independent cross-review found the base `no-restricted-imports` rule
    only handles static `import` / `export … from`, so `await import('@/…')`
    and `require('@/…')` slipped past the boundary and resolved at runtime —
    the exact "temporary punch-through" the rule exists to prevent.
    
    Close the gap dependency-free with `no-restricted-syntax` selectors for
    `ImportExpression` and `require()` `CallExpression` targeting `@/…`, and
    tighten the comment to describe what lint actually enforces (relative
    parent escapes stay out of scope for this alias rule; the package's own
    `tsc` rootDir rejects those at build).
    
    Verified: dynamic `import('@/lib/store')` and `require('@/lib/store')`
    now error; `import('@openmaic/dsl')` / `import('echarts')` stay clean;
    package source lints clean.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * chore(renderer): close template-literal and require.resolve `@/` bypasses
    
    Review feedback: the dynamic-import guard matched only string-literal
    sources and bare `require()`, so `import(`@/x`)` (no-substitution template
    literal) and `require.resolve('@/x')` still reached app-owned paths.
    
    Extend the no-restricted-syntax selectors to cover template-literal sources
    and `require.resolve` across `import()` / `require()` / `require.resolve()`
    (string-literal and template-literal forms).
    
    Verified: all 6 static `@/` dynamic forms error; `import('@openmaic/dsl')`,
    `require('fs')`, `require.resolve('path')` and bare `'@/…'` strings are
    unaffected; package lints clean. Genuinely computed sources such as
    `import(someVar)` remain undecidable by lint and are out of scope for any rule.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * chore(renderer): prettier-format the boundary rule block
    
    Formatting only — the previous commit's added selectors were not
    prettier-conformant, failing the CI Prettier step. No behaviour change;
    `prettier . --check` now passes and the rule still flags all `@/` forms.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * chore(renderer): match the `@/` string prefix, not import call shapes
    
    Review feedback: the shape-specific selectors missed string concatenation
    (`import("@/lib/" + "foo")`, `require.resolve("@/lib/" + "foo")`). Replace the
    six import/require/require.resolve selectors with two that flag any `@/…` string
    the package authors (`Literal` + `TemplateElement`). This subsumes dynamic
    import/require/require.resolve in any quote style and catches concatenation
    operands, since the `"@/lib/"` literal is itself flagged. The package has zero
    legitimate `@/…` strings, so there are no false positives.
    
    Residual: a specifier assembled entirely from non-`@/` pieces (`"@" + "/x"`, or a
    variable) is undecidable by any lint rule and reachable only by deliberate
    evasion; the package's standalone build is the backstop.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * chore(renderer): scope the boundary rule to import contexts (fix over-match)
    
    Review: the prefix-matching guard (`Literal[value=/^@\//]`) was broader than the
    rule's intent — it flagged any authored `@/…` string even when not an import
    (`const x = '@/lib/foo'`) and double-reported static imports already covered by
    `no-restricted-imports`.
    
    Narrow `no-restricted-syntax` back to import contexts: dynamic
    `import()` / `require()` / `require.resolve()` on string- or template-literal
    specifiers. Static `import` / `export … from` stays with `no-restricted-imports`
    (single report). Concatenation and computed specifiers (`'@/lib/' + x`, a
    variable) and relative parent escapes are documented as out of scope —
    undecidable by lint, evasion-only, and caught instead by building the package in
    isolation.
    
    Verified both directions: bare `@/…` strings and legitimate imports are clean
    (no false positives, no double-report); static / dynamic / require /
    require.resolve app imports are still blocked.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * chore(renderer): also block import.meta.resolve('@/…') in the boundary
    
    Review: `import.meta.resolve()` — the ESM counterpart to `require.resolve()` —
    was not covered, although the package is ESM-only ("type": "module"). Add the
    two selectors (string- and template-literal specifier).
    
    This completes the set of single-literal module-reference forms the rule covers:
    static import / side-effect import / export-from / import() / require() /
    require.resolve() / import.meta.resolve(). Computed/concatenated/variable
    specifiers remain out of scope (documented) → build backstop.
    
    Verified both directions: all seven @/ forms are blocked; import.meta.resolve of
    a non-@/ specifier, bare @/ strings, and legitimate imports stay clean (no false
    positives, no double-report).
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * chore(renderer): match the `@/` prefix (complete against all single-literal forms)
    
    Per-call-shape selectors don't converge: each covered form (dynamic import,
    require, require.resolve, import.meta.resolve, dot-property access) just invites
    the next variant — template literals, computed `require["resolve"]`,
    `import.meta["resolve"]`. The shape space is open-ended.
    
    Replace them with the one check that closes the whole class: flag any `@/…`
    string literal or template element the package authors. This covers every
    single-literal module-reference form regardless of call or property-access shape,
    with one report per violation (no more double-reporting static imports). The
    package authors zero `@/…` strings, so it has no false positives on real code; a
    bare `@/…` string is flagged by design — there is no legitimate `@/` string in
    this package.
    
    Still out of scope (undecidable by lint, evasion-only): a specifier assembled
    from non-`@/` parts (`"@" + "/x"`, a variable) and relative parent escapes —
    covered by building/publishing the package in isolation.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    ---------
    
    Co-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

 eslint.config.mjs | 39 +++++++++++++++++++++++++++++++++++++++
 1 file changed, 39 insertions(+)

commit b53f202d9d104662c60dfabde4649effdab8a22e
Author: wyuc <wang-yc24@mails.tsinghua.edu.cn>
Date:   Mon Jul 6 01:20:58 2026 -0400

    feat(renderer): scaffold @openmaic/renderer/editing subpath (v2 editing surface, Stage 0) (#855)
    
    * feat(renderer): scaffold the @openmaic/renderer/editing subpath (v2 Stage 0)
    
    Adds the packaging skeleton for the renderer v2 editing surface behind a
    dedicated `./editing` subpath export, so the read-only entry
    (@openmaic/renderer) never pulls the editing bundle — packaging decision A
    from the editing-surface RFC.
    
    Scaffold only, no interaction logic yet:
    - src/editing/types.ts: the L1 edit-intent contract (EditIntent, Selection,
      EditableSlideCanvasProps) — the bounded canvas gesture vocabulary. The agent
      tool surface (L2) and the canonical change (L0, @openmaic/dsl) are out of
      scope here.
    - src/editing/EditableSlideCanvas.tsx: a shell that renders through the v1
      read-only SlideCanvas and supports click-to-select only. Operate handles,
      snapping, ProseMirror inline editing, and onElementsChange emission land in
      Part A / Part B.
    - package.json + rollup.config.js: wire the ./editing entry (mirrors ./snapshot).
    
    Refs #851 (renderer v2 editing surface, #720 Phase 3).
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * fix(renderer): address editing-scaffold cross-review
    
    - Add `'use client'` to EditableSlideCanvas so the editing subpath is a proper
      client boundary (every v1 client component leads with it). Without it, a Next
      App Router server component importing the subpath would reject the function
      props the shell passes to the client SlideCanvas.
    - Drop the wrapper `<div>`: it had `height: auto`, collapsing SlideCanvas's
      `height: 100%` auto-fit to 0 (the slide rendered invisibly). Forward
      `className`/`style` straight to SlideCanvas, preserving the v1 fill contract.
    - Freeze `EMPTY_SELECTION` and type `Selection.elementIds` as `readonly` so the
      shared sentinel cannot be mutated.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * fix(renderer): add 'use client' to the public editing entry
    
    Review follow-up: put the client-boundary directive on the public
    `@openmaic/renderer/editing` entry (the barrel that consumers resolve), not
    only on EditableSlideCanvas.tsx.
    
    Note: this is necessary but not sufficient on its own — the rollup build
    currently drops module-level directives (the config's onwarn silences the
    MODULE_LEVEL_DIRECTIVE warning), so the published bundle strips `'use client'`
    today (the published v1 dist has none either). The effective fix is preserving
    directives in the build; tracked separately since it changes the whole
    package's published output.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * fix(renderer): preserve 'use client' in the build output
    
    The rollup build stripped module-level directives (the MODULE_LEVEL_DIRECTIVE
    warning is silenced in onwarn), so the published dist dropped 'use client' from
    every file — including the editing entry and v1's client components — which
    breaks Next App Router server-component consumers.
    
    Enable `preserveModules` (the `preserveModulesRoot` option was already present but
    inert without it) and add `rollup-plugin-preserve-directives`, so each source
    module's `'use client'` survives per-file into dist.
    
    Verified against the built output:
    - dist/editing/index.js and dist/editing/EditableSlideCanvas.js keep 'use client'
    - dist/SlideCanvas.js (v1) keeps it too (it was dropped before)
    - dist/index.js (read-only barrel) stays clean — re-exports the client module,
      so the read-only path/design is unchanged and still doesn't pull the editing bundle
    - all export entries (., ./elements, ./types, ./snapshot, ./editing) resolve
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    ---------
    
    Co-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

 packages/@openmaic/renderer/package.json           |  5 ++
 packages/@openmaic/renderer/rollup.config.js       | 11 +++
 .../renderer/src/editing/EditableSlideCanvas.tsx   | 41 +++++++++++
 packages/@openmaic/renderer/src/editing/index.ts   | 12 +++
 packages/@openmaic/renderer/src/editing/types.ts   | 85 ++++++++++++++++++++++
 pnpm-lock.yaml                                     | 30 ++++++--
 6 files changed, 176 insertions(+), 8 deletions(-)

commit ee626121cdc69cd559291d8aba5098980c8ca14b
Author: yipwingtim <jwen@fudan.edu.cn>
Date:   Sun Jul 5 23:08:49 2026 +0800

    fix(slide): tolerate malformed generated slide data

 .../components/element/ShapeElement/index.tsx      | 24 +++++++++++++---
 .../element/TableElement/StaticTable.tsx           | 32 ++++++++++++++--------
 .../components/element/TableElement/tableUtils.ts  | 14 ++++++----
 .../components/element/TextElement/index.tsx       |  5 ++--
 tests/slide-renderer/table-utils.test.ts           | 12 ++++++++
 5 files changed, 64 insertions(+), 23 deletions(-)

commit be57c52d3efc952297dbebaa328f2f4df865814a
Author: Lee-Flier <lxf198961@yeah.net>
Date:   Sun Jul 5 17:11:28 2026 +0800

    fix(docker): fix postinstall script failure in Docker build (#835)
    
    Fix Docker builds by making the deps stage copy scripts before pnpm install, then carrying the generated public/vendor importer bundle from deps into the builder stage.

 Dockerfile | 2 ++
 1 file changed, 2 insertions(+)

commit b669f791db0a979b48792d978e5565dd15f3abd0
Author: wyuc <wang-yc24@mails.tsinghua.edu.cn>
Date:   Sun Jul 5 01:14:23 2026 -0400

    feat(importer): normalize slides at the pipeline output boundary (#787 follow-up) (#845)
    
    * feat(importer): normalize slides at the pipeline output boundary (#787)
    
    Wire the DSL contract's element normalization at the importer's output
    boundary, the counterpart of the generator wiring that landed with
    normalize itself: parsedToSlides (and therefore importPptx) now runs
    every transformed element through normalizeElement.
    
    - normalizeImportedSlides: fills any required content field the
      transform left off and derives geometry-dependent fields; an element
      normalization cannot repair is dropped with a warning instead of
      failing the whole import or reaching consumers unguarded, matching
      the importer's existing degrade-not-fail upload policy.
    - exported from the package root for consumers that call
      transformParsedToSlides directly.
    - test/normalizeImportedSlides.test.ts covers default-filling,
      pass-through of well-formed elements, drop-and-warn on malformed
      input, input purity, and the parsedToSlides end-to-end boundary.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
    
    * fix(dsl): preserve explicit empty shape fill; own the drop policy in normalizeSlide
    
    Cross-review round on the importer boundary wiring surfaced two issues,
    both fixed at the contract level:
    
    - normalizeShape no longer treats an explicit `fill: ''` as absent. The
      empty string is a meaningful fill — "no solid fill" (transparent, or
      gradient/pattern carried by sibling fields) — and the renderer maps it
      to `none`. Defaulting it painted every imported gradient / image-filled
      / unfilled shape with the canonical color. Font/color fields keep the
      empty-is-absent repair semantics; only `fill` uses the new
      strKeepEmpty. (This also means a generator-emitted `fill: ''` now
      renders as intended no-fill instead of the legacy default color.)
    
    - normalizeSlide gains an optional { onInvalid: 'throw' | 'drop',
      onDropped } policy, so producers normalizing wild-world input own a
      single shared repair-or-drop pass instead of each hand-rolling the
      try/normalizeElement/catch idiom (the importer was about to become the
      second copy alongside the generator's). Default stays 'throw'.
      normalizeScene/normalizeStage now call normalizeSlide via an explicit
      arrow so map's index can't land in the options parameter.
    
    The importer's normalizeImportedSlides composes normalizeSlide with the
    drop policy, keeps the console.warn reporting, and documents that direct
    transformParsedToSlides callers should apply it themselves. New tests:
    empty-fill preservation (dsl unit + importer unit + parsedToSlides
    end-to-end regression), drop-policy semantics, plus the existing suite.
    
    @openmaic/dsl 0.3.0 -> 0.4.0 (new normalizeSlide option).
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
    
    * docs(importer): document normalizeImportedSlides in the README API surface
    
    Round-2 review finding: the function is a public export whose docstring
    tells direct transformParsedToSlides callers to apply it, but it was
    missing from the API table and signature block.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
    
    * fix(dsl): keep normalizeSlide unary via curried normalizeSlideWith; bump importer to 0.1.0
    
    Addresses review:
    
    - normalizeSlide is unary again, so existing point-free
      `slides.map(normalizeSlide)` call sites keep type-checking. The
      element-invalidity policy moves to normalizeSlideWith(options), which
      returns a map-safe unary function (and returns normalizeSlide itself
      when no drop policy is requested). normalizeScene/normalizeStage go
      back to plain .map(normalizeSlide); the importer builds its dropper
      once and maps it. A test pins the point-free ergonomics.
    
    - @openmaic/importer 0.0.2 -> 0.1.0: the publish workflow is
      version-bump driven and 0.0.2 is already on npm; without the bump the
      new export + output-boundary behavior would never ship.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
    
    ---------
    
    Co-authored-by: Claude Fable 5 <noreply@anthropic.com>

 packages/@openmaic/dsl/README.md                   |   2 +-
 packages/@openmaic/dsl/package.json                |   2 +-
 packages/@openmaic/dsl/src/normalize.ts            |  70 ++++++++++++-
 packages/@openmaic/dsl/test/normalize.test.ts      |  54 ++++++++++
 packages/@openmaic/importer/README.md              |   4 +
 packages/@openmaic/importer/package.json           |   2 +-
 .../importer/src/import-pipeline/index.ts          |  42 +++++++-
 packages/@openmaic/importer/src/index.ts           |   1 +
 .../importer/test/normalizeImportedSlides.test.ts  | 111 +++++++++++++++++++++
 9 files changed, 278 insertions(+), 10 deletions(-)

commit 6b93980f82f5611ed78d29a152cf31411d57c5ea
Author: wyuc <wang-yc24@mails.tsinghua.edu.cn>
Date:   Fri Jul 3 03:26:38 2026 -0400

    feat(editor): redesign the narration timeline (action picker + inline insert) and enable it for interactive/PBL scenes (#834)
    
    * feat(editor): enable narration timeline for interactive/pbl scenes
    
    * docs(editor): fix stale timeline-gating comment in EditChromeRoot
    
    * i18n(editor): add action-picker + addAction strings
    
    * feat(editor): pure pickerOptions filter for the action picker
    
    * feat(editor): ActionPicker popover (shared by header pill + inline +)
    
    * feat(editor): header add-action pill opens ActionPicker; drop drag-chips
    
    * feat(editor): inline + insert between cells opens ActionPicker
    
    * style(editor): reskin SpeechClip + TTS footer to Pro Mode v2
    
    * style(editor): align discussion dash tint to neutral primary token
    
    Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
    
    * style(editor): reskin CueMarker (bound label) + DiscussionClip + NodeDot
    
    * fix(editor): complete picker i18n locales, label inline insert button, use primary token
    
    - Add edit.timeline.addAction and edit.picker.{title,speechDesc,spotlightDesc,laserDesc,discussionDesc}
      to zh-TW, ja-JP, ko-KR, ru-RU, pt-BR, ar-SA locale files, mirroring the
      existing en-US/zh-CN structure.
    - Give the inline "+" insert button in ActionsBar's DropZone an accessible
      name (aria-label + title) by threading an insertLabel prop from the root
      component, which already has the translator.
    - Replace the raw bg-violet-500 active-divider glow in DropZone with the
      bg-primary token.
    
    * chore(editor): drop dead drag-to-add path and orphaned i18n keys, explain disabled discussion option
    
    * style: format picker-options with prettier
    
    ---------
    
    Co-authored-by: Claude Opus 4.8 <noreply@anthropic.com>

 components/edit/ActionsBar/ActionPicker.tsx  | 122 ++++++++++++++++
 components/edit/ActionsBar/ActionsBar.tsx    | 210 ++++++++++++++-------------
 components/edit/ActionsBar/cue-meta.ts       |  12 ++
 components/edit/ActionsBar/picker-options.ts |  25 ++++
 components/edit/EditChromeRoot.tsx           |  13 +-
 components/edit/scene-timeline.ts            |  17 +++
 lib/i18n/locales/ar-SA.json                  |  12 +-
 lib/i18n/locales/en-US.json                  |  12 +-
 lib/i18n/locales/ja-JP.json                  |  12 +-
 lib/i18n/locales/ko-KR.json                  |  12 +-
 lib/i18n/locales/pt-BR.json                  |  12 +-
 lib/i18n/locales/ru-RU.json                  |  12 +-
 lib/i18n/locales/zh-CN.json                  |  12 +-
 lib/i18n/locales/zh-TW.json                  |  12 +-
 tests/edit/picker-options.test.ts            |  26 ++++
 tests/edit/scene-timeline.test.ts            |  16 ++
 16 files changed, 411 insertions(+), 126 deletions(-)

commit 0b1304fe0c66d8aef96e358d618f57d45bedaabd
Author: wyuc <wang-yc24@mails.tsinghua.edu.cn>
Date:   Fri Jul 3 03:05:51 2026 -0400

    fix(editor): show per-line loading while the batch "regenerate all TTS" runs (#830)
    
    Clicking the batch "regenerate all TTS" control (the timeline's "voice all"
    button) only set a global in-flight flag and spun the button; each speech
    line's status row (preview / regenerate) kept showing its old status, so the
    batch gave no per-line feedback — even though the single-line regenerate path
    shows a "generating" state.
    
    Track the ids being regenerated in ActionsBar and pass a `regenerating` flag
    down to each SpeechTtsBar; while set, the line shows the generating state
    (spinner + disabled buttons) and the single-line regenerate is disabled (no
    concurrent double-regen).
    
    To avoid a ~1-frame flash back to the "not voiced" status at batch end (the
    parent flag clears before the async audioExists re-check resolves), each line
    latches a `batchPending` flag on the rising edge of `regenerating` (adjusted
    during render, not in an effect) and clears it inside its own audio re-check
    effect. The clear is guarded by `!regenerating` (and `regenerating` is an
    effect dep, so a stale pre-batch check is cancelled at batch start), so only
    the batch-end re-check clears the latch. The re-check is wrapped so an
    IndexedDB rejection still clears the latch (the row can never wedge in the
    generating state), and ttsRefresh is always bumped in the finally so every
    line re-checks at batch end, including the all-fail case.
    
    Co-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

 components/edit/ActionsBar/ActionsBar.tsx | 73 ++++++++++++++++++++++++++-----
 1 file changed, 62 insertions(+), 11 deletions(-)

commit fcdb6d62b380c066de2a4733910669c9e697b83a
Author: wyuc <wang-yc24@mails.tsinghua.edu.cn>
Date:   Fri Jul 3 02:19:38 2026 -0400

    feat(dsl): own element-level normalization & defaults; wire the generator (#787) (#832)
    
    * feat(dsl): own element defaults + normalize(); wire the generator (#787)
    
    Bring element-level normalization into the @openmaic/dsl contract, so producers
    stop carrying their own imperative "fix up the output" pass. Companion to the
    #817 validators: where validate* reports on a document, normalize* repairs one.
    
    - src/normalize.ts: pure, zero-dep normalizeElement / normalizeSlide /
      normalizeScene / normalizeStage + canonical ELEMENT_DEFAULTS. Fills missing
      required content fields, derives geometry (a line's start/end, a shape's
      viewBox/path from its box), and FAILS LOUD on a present-but-wrong-typed field
      instead of silently resetting it. Pure, non-mutating, idempotent. Scope is
      element content — base identity/geometry (id, left/top/width/height/rotate) is
      producer-supplied (the id is assigned downstream) and left to validate*/schema.
    - slides.ts: static defaults ride out on the generated JSON Schema as @default
      annotations (so non-TS consumers ship them too); ELEMENT_DEFAULTS is the
      single source of truth, pinned to the schema by a lockstep test.
    - generator: fixElementDefaults drops its per-type fixups for normalizeElement,
      wrapped in try/catch so a malformed element degrades gracefully (log + keep
      raw) rather than aborting a whole scene/course — generation runs on unreliable
      model output and on legacy slides the old pass itself produced. Image
      aspect-ratio reconciliation stays (it needs the resolved asset's real
      dimensions — a producer concern the DSL does not own).
    
    Two latent bugs fixed while canonicalizing into the contract:
    - shape viewBox: the old missing-viewBox fallback emitted a string "0 0 w h",
      which every consumer reads as viewBox[0]/[1]; normalize emits the contract's
      [w, h] pair.
    - line start/end: the old fallback derived ABSOLUTE [left, top] coordinates, but
      the renderer positions the line container at (left, top) and reads start/end
      as LOCAL offsets (getLineElementPath / getElementRange) — double-offsetting
      the line. normalize derives them in the local frame ([0,0] .. [w, h]).
    
    Minor bump @openmaic/dsl 0.2.0 -> 0.3.0. test/normalize.test.ts covers the
    defaults, derivation (incl. the local-frame line regression), fail-loud
    coercion, purity/idempotency, generic app-widened normalizeScene, schema
    conformance of normalized output, and the ELEMENT_DEFAULTS <-> schema lockstep.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * style: format normalize.ts / normalize.test.ts with prettier
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * fix(dsl): normalize nested ShapeText; repair-or-drop malformed elements in the generator
    
    Address review on #832:
    
    - normalizeShape now normalizes a present `text` overlay (ShapeText): fills
      content / defaultFontName / defaultColor / align with canonical defaults
      (align 'middle' per the renderers' convention), fails loud on a malformed
      overlay. Consumers read `text.content` unguarded (the PPTX exporter feeds it
      to formatHTML), so a present overlay gets the same repair semantics as the
      element's own required fields. Defaults ride the schema as @default and are
      pinned by the lockstep test.
    - The generator's fixElementDefaults no longer keeps a raw element when
      normalization fails — repair or drop: JSON nulls from the model are stripped
      first (null means absent; normalize then fills/derives the field), and an
      element that still fails is discarded with a warning. Keeping the raw payload
      handed malformed lines (start/end null) to consumers that index straight into
      start[0] (getElementRange / BaseLineElement / export), crashing playback or
      export over one bad element.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    ---------
    
    Co-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

 lib/generation/scene-generator.ts             | 156 +++++-------
 packages/@openmaic/dsl/README.md              |  41 ++-
 packages/@openmaic/dsl/package.json           |   2 +-
 packages/@openmaic/dsl/scripts/gen-schema.mjs |   5 +
 packages/@openmaic/dsl/src/index.ts           |  12 +-
 packages/@openmaic/dsl/src/normalize.ts       | 346 +++++++++++++++++++++++++
 packages/@openmaic/dsl/src/slides.ts          |  13 +
 packages/@openmaic/dsl/test/normalize.test.ts | 347 ++++++++++++++++++++++++++
 8 files changed, 821 insertions(+), 101 deletions(-)

commit 4b821272ffc3247c60eb901292d7042e80018836
Author: Yanpeng Wang <yanpg.wang@gmail.com>
Date:   Fri Jul 3 14:09:03 2026 +0800

    feat(interactive-actions): feed real HTML element inventory into the prompt (#829)
    
    * feat(interactive-actions): feed real HTML element inventory into the prompt
    
    Teacher actions (highlight/setState/annotation/reveal) for interactive scenes
    frequently miss because the model has to guess selectors from the prompt's
    naming conventions (e.g. `#{var}-slider`, `#start-btn`) that don't match the
    ids the content model actually emits (`#score-val`, `#launch-btn`, …). The
    game widget category is the worst hit because its conventions cover almost
    nothing.
    
    Extract an inventory of interactable elements (ids + notable classes +
    aria/role/data-step-id) from the generated widget HTML and thread it into
    `INTERACTIVE_ACTIONS` under an `{{elementInventory}}` variable. The system
    prompt now instructs the model to select `target` from the inventory first
    and only fall back to conventions when nothing matches.
    
    The inventory is:
    - Persisted on the runtime `InteractiveContent` so pro-mode
      `regenerate_scene_actions` gets the same real selectors, not a stale guess.
    - Refreshed by `edit_interactive_html` — the tool re-runs the extractor on
      the post-edit HTML and the client writes it back into `scene.content`, so
      a subsequent action regen sees the new dom.
    - Computed on the fly in `generateSceneActions` when a legacy scene lacks it,
      so pre-existing courses benefit without a data migration.
    
    Tailwind / utility class tokens are filtered so the 30-class inventory cap
    keeps semantic hooks like `.pairing-rules`, `.dna-card`, `.btn-launch` from
    being crowded out by layout tokens.
    
    * style: prettier format
    
    * fix(interactive-actions): compute element inventory at prompt-build time
    
    Address PR #829 review feedback:
    
    1. Drop the persisted `elementInventory` field on
       `InteractiveContent`/`GeneratedInteractiveContent`. `generateSceneActions`
       already computes the inventory on the fly from `content.html`; make that
       the only path. Removes born-stale mismatches (post-processing rewrite vs
       raw-html extraction), same-turn staleness of `sceneContextMap`, and the
       silent divergence between `createSceneWithActions` (drops the field) and
       `scene-builder.ts` (keeps it) — server-generated classrooms already ran
       in recompute-only mode today.
    
    2. Extractor hardening:
       - Strip HTML comments alongside `<script>` / `<style>` so commented-out
         markup can't forge phantom inventory entries the prompt would prefer.
       - Drop content after an unmatched `<script` open so a truncated
         generation doesn't inventory ids inside `innerHTML` template strings.
       - Parse attributes into a name→value map by walking the tag grammar
         instead of per-attribute regex over the flat string. Prevents
         `aria-label="try name=alpha or id=fake"` from lifting phantom
         `name=alpha` / `id=fake` attributes.
       - Collapse whitespace and truncate each attribute value (~120 chars)
         when building inventory lines so a multi-line or hostile aria-label
         can't fake prompt sections.
       - Keep semantic hooks whose names collide with Tailwind category
         prefixes (`.grid-cell`, `.fill-blank`, `.text-input`, `.select-btn`,
         `.ring-carbon`) when they are declared in the page's own `<style>`
         block.
    
    * style: prettier format
    
    * fix(interactive-actions): surface id-less data-attribute targets in inventory
    
    The interactive-actions system prompt tells the model to prefer
    `[data-step-id="step-1"]` selectors for procedural-skill widgets whose
    step rows typically carry only `data-step-id` (no id, and often no
    surviving semantic class). Under the previous extractor those rows were
    invisible: `data-step-id` and `data-action` only surfaced as decoration
    on id rows, so a widget with all-data-only steps could hit the
    "(no interactive elements detected)" sentinel while the system prompt
    kept telling the model to prefer the inventory — degrading exactly the
    one widget family the conventions already served well.
    
    Add a third `Stable data attributes:` section that emits an
    `[data-step-id="step-1"] <li>` line for each id-less element carrying
    data-step-id or data-action, deduped on attribute value and capped at 30
    entries. Elements that already have an id keep those attributes as row
    decoration only (no duplicate row).

 lib/agent/client/apply-regenerate.ts               |  10 +-
 lib/agent/tools/edit-interactive-html.ts           |   6 +-
 lib/generation/scene-generator.ts                  | 289 +++++++++++++++++++++
 .../templates/interactive-actions/system.md        |   2 +-
 lib/prompts/templates/interactive-actions/user.md  |   4 +
 .../extract-interactive-elements.test.ts           | 250 ++++++++++++++++++
 .../interactive-inventory-fallback.test.ts         |  87 +++++++
 ...widget-teacher-actions-procedural-skill.test.ts |   3 +
 8 files changed, 647 insertions(+), 4 deletions(-)

commit d54e62f5c49f8a83cc70b2839e2e0087ff392ca7
Author: Yanpeng Wang <yanpg.wang@gmail.com>
Date:   Fri Jul 3 11:03:12 2026 +0800

    feat(token-plan): one-click token-plan setup + deployment usage dashboard (#784)
    
    * feat(usage): add usage normalization, pricing, model-fetch, balance, storage
    
    Foundational layer for token-plan usage tracking (cc-switch-modeled):
    - lib/usage/normalize.ts: AI SDK v6 usage → four-class token shape
    - lib/usage/pricing.ts + defaults: per-class USD pricing table
    - lib/server/model-fetch.ts: /models candidate-URL multi-fallback (ported)
    - lib/usage/balance-providers.ts: built-in balance queries + detection
    - lib/server/usage-storage.ts: fire-and-forget jsonl logging to data/usage
    
    All pure/storage logic covered by vitest (32 tests).
    
    * feat(usage): capture token usage at the callLLM/streamLLM chokepoint
    
    - callLLM records result.usage before returning
    - streamLLM wraps onFinish to record totalUsage on stream completion,
      preserving any caller-supplied onFinish
    - provider/model derived from the model instance (no route changes)
    - fs-backed storage imported dynamically; fire-and-forget, never throws
    - include_usage is already sent by @ai-sdk/openai, so streaming is covered
    
    * feat(usage): add probe-models, balance, and usage API routes
    
    - POST /api/provider/probe-models: discover chat models via /models with
      candidate fallback; SSRF-guarded; filters non-chat ids; 401/404 typed
    - POST /api/provider/balance: built-in balance detection + billing fallback
    - GET /api/usage: aggregate jsonl by model/day/source with costIncomplete flag
    
    Verified e2e against the live MAIC gateway: 16 chat models (6 filtered),
    balance detected, and a real callLLM writes a costed usage row.
    
    * feat(settings): add token-plan preset picker to provider dialog
    
    - lib/config/token-plan-presets.ts: data-driven vendor presets (Huawei/MiniMax/
      Xiaomi token plans, OpenRouter/SiliconFlow gateways, DeepSeek/GLM/Qwen/Hunyuan/
      Doubao direct) with baseURL, protocol, optional modelsUrl, category
    - add-provider-dialog: '选择厂商/自定义' tabs; picking a preset auto-fills
      baseURL+protocol+modelsUrl, custom tab unchanged
    - ProviderSettings.modelsUrl carries the optional /models override
    - i18n keys added across all 8 locales
    
    Verified in-browser: preset picker renders grouped by category.
    
    * feat(settings): add Fetch Models button and balance bar to provider panel
    
    - 拉取模型: probes /models, merges discovered ids into the model list
      (dedupe, keeps manual additions), with success/no-endpoint/auth messages
    - 查询余额: queries /api/provider/balance, renders a balance bar or a
      'check console' hint when unsupported
    - index.tsx: handleModelsFetched merges probe results into provider config
    - i18n keys across all 8 locales; removed a now-unused eslint-disable
    
    Verified in-browser against MAIC gateway: 16 models fetched, balance shown.
    
    * feat(settings): add usage dashboard to System Settings
    
    - usage-dashboard.tsx: echarts dual-axis daily trend (tokens + cost),
      totals cards, by-model table, refresh; reads GET /api/usage
    - mounted at the top of GeneralSettings (系统设置)
    - honest disclaimer + costIncomplete marker when a model lacks pricing
    - i18n keys across all 8 locales
    
    Verified in-browser: shows 1 request / 31 tokens / $0.0003 from a prior call.
    
    * feat(token-plan): multi-modal one-click setup in System Settings
    
    - token-plan-presets.ts: presets now declare per-modality targets
      (llm/image/video/tts/webSearch); MiniMax is the full-set template,
      others LLM-only — extend by adding entries (at-our-best adaptation)
    - apply-token-plan.ts: fills one key into every declared modality via
      injected store setters, isolating per-modality failures (TDD, 4 tests)
    - token-plan-settings.tsx: new sidebar page — pick plan, enter key,
      one-click apply lights up adapted modalities (+LLM model probe),
      shows 'not adapted yet' for the rest, balance bar reused
    - reverted add-provider dialog to plain custom form (preset picker moved here)
    - i18n across all 8 locales
    
    Verified in-browser: Token Plan page renders, MiniMax shows all 5
    modalities, apply/balance UI wired. 859 tests pass, build clean.
    
    * feat(token-plan): add custom token plan entry to Token Plan page
    
    - Custom card at the bottom of the provider list: pick it to manually enter
      name + protocol + baseURL (LLM-only), then key + one-click apply via the
      same applyTokenPlan flow (mirrors cc-switch's custom provider)
    - effectivePreset unifies preset vs custom for apply/balance/probe
    - i18n keys (customGroup/customName/customHint) across all 8 locales
    
    Verified in-browser: custom card expands the manual form; preset flow intact.
    
    * feat(token-plan): reflect persisted config on the Token Plan page
    
    Other settings panels read the store directly, so they survive section
    switches; the Token Plan page only wrote the store, so it looked blank on
    return. Now it also reads providersConfig:
    - selecting a preset prefills its saved API key
    - configured presets show a '已配置/Configured' badge
    
    State persistence was never broken (apply writes zustand→localStorage);
    this fixes the missing read-back so the page reflects it.
    
    * fix(settings): isLLMProviderConfigured crashed on providers without models
    
    Root cause of 'token plan config disappears': applyTokenPlan writes a new
    LLM provider with no models yet (probe fills them later). isLLMProviderConfigured
    did config.models.length unguarded → threw inside setProviderConfig's resolver
    → the whole set() aborted → key/baseUrl/type never persisted.
    
    - guard models in isLLMProviderConfigured (shared validator; affects any
      provider written without a models array)
    - seed models:[] in applyTokenPlan's LLM write for a valid initial shape
    - regression tests: validator no longer throws; apply+probe write keeps apiKey
    
    Verified in-browser: DeepSeek persists key and shows 已配置 after section switch.
    
    * feat(token-plan): add remove/teardown for a configured token plan
    
    Apply had no inverse. Add removeTokenPlan: clears the API key and disables
    (enabled:false) every modality the plan declared; a custom LLM provider is
    deleted entirely (removeProvider), built-ins keep the cleared shape.
    
    - removeTokenPlan in apply-token-plan.ts (mirrors applyTokenPlan, isolated
      per-modality, injected setters; 3 tests)
    - trash button on configured preset cards in the Token Plan page; resets
      page state if the removed plan was selected
    - i18n 'remove' across all 8 locales
    
    Verified in-browser: removing DeepSeek empties its key and drops the
    已配置 badge.
    
    * feat(usage): track multimodal usage, drop cost/pricing
    
    Reframe usage stats as pure usage (no cost), per user decision:
    - usage-storage: drop all cost fields; add kind (llm/image/video/tts/asr)
      + quantity + unit; LLM keeps token counts, others store quantity
    - delete lib/usage/pricing.ts + pricing-defaults.json + its test
    - instrument image/video/tts at the server-only API routes (not in the
      provider dispatch — those files are in the client graph and importing
      fs-backed usage-storage broke the client bundle)
    - /api/usage: aggregate by model/day/modality, no cost
    - dashboard: per-modality usage (tokens/images/seconds/chars), token-only
      daily trend, no '$'; i18n cost keys replaced with modality/unit keys
    - backward compatible: legacy rows (no kind, stray cost fields) read as llm
    
    912 tests pass, build clean.
    
    * feat(usage): per-modality dashboard layout + softer dark-mode chart
    
    - group usage into per-modality sections (LLM/image/video/tts/asr), each
      table's usage column uses one consistent unit (token/image/sec/char) —
      no more mixed units in a single column
    - summary chips per modality with their own unit
    - trend chart now plots daily REQUESTS (unit-agnostic, works for any
      modality) instead of LLM-only tokens
    - theme-aware chart: faint thin line + soft gradient area, muted axis/grid
      colors via useTheme — fixes the harsh solid stroke in dark mode
    
    Verified in-browser (dark): TTS shows '字符', LLM shows 'Token', separate
    sections; chart no longer has a hard line.
    
    * refactor(usage): dedupe model/fetch/usage helpers, parallel balance probe
    
    Review cleanups on the token-plan/usage branch:
    - extract modelInfoFromId() (shared vision heuristic + ModelInfo shape)
    - extract fetchWithTimeout() shared by model-fetch and balance-providers
    - extract recordGenerationUsage() to dedupe the image/tts/video routes
    - queryBalance: fetch billing subscription + usage in parallel
    - parseOneApiBilling: report quota without remaining when usage endpoint
      is unavailable, instead of implying zero spend (full balance)
    - split the two jammed imports in settings/index.tsx
    
    * feat(token-plan): drop custom token-plan support
    
    Custom token plans (manual baseURL/protocol entry) added complexity for
    little gain — a one-off provider is better configured directly on the
    Providers page. Token Plan is now preset-only:
    - remove custom mode, manual fields, and the custom card from the UI
    - collapse effectivePreset back to the selected preset
    - drop the now-dead removeProvider action + custom-id branch in
      removeTokenPlan
    - remove orphaned customGroup/customName/customHint i18n keys (8 locales)
    
    * feat(token-plan): add Volcengine/Tencent/Bailian plans, drop balance feature
    
    Add three vendor token-plan presets (all map to existing built-in LLM
    providers, so it's data-only — no new adapters):
    - 火山方舟 Volcengine Ark → doubao, OpenAI /api/v3
    - 腾讯 TokenHub Token Plan → tencent-hunyuan, OpenAI /plan/v3 (the
      plan-specific base; /v1 is the pay-as-you-go gateway)
    - 阿里百炼 Token Plan → qwen, cross-model plan (Qwen + DeepSeek/Kimi/
      GLM/MiniMax) on one key; model list is probed/entered
    
    Remove the balance/quota feature entirely — we now track usage, not cost,
    and every vendor's balance query needs its own cloud AK/SK + signature
    (Volcengine SigV4 / Tencent TC3 / Aliyun BSS), which the Bearer-key
    billing-endpoint probe never supported anyway:
    - delete lib/usage/balance-providers.ts, /api/provider/balance, its test
    - strip the Check Balance button + balance bar from the token-plan page
      and the provider config panel
    - remove the 4 balance i18n keys across all 8 locales
    - restore an eslint-disable the branch had dropped in provider-config-panel
    
    * feat(token-plan): use cloud-brand logos for vendor token plans
    
    The three vendor plans are cloud offerings, not single-model products, so
    icon them with the cloud brand rather than a model logo:
    - 火山方舟 → volcengine.svg (was doubao.svg)
    - 腾讯 TokenHub → tencentcloud.svg (was hunyuan.svg)
    - 阿里百炼 → alibabacloud.svg (was bailian.svg)
    
    Logos are the colored brand variants from lobehub/lobe-icons, matching the
    existing colored-logo style (plain <img>, no dark:invert needed).
    
    * feat(token-plan): keep only MiniMax and Volcengine presets
    
    Trim the token-plan list to the two we want to ship: MiniMax (full-set
    template) and 火山方舟 Volcengine Ark. Drop the Tencent/Bailian plans and
    the OpenRouter/SiliconFlow/DeepSeek/GLM/Qwen entries.
    
    - remove the now-unused tencentcloud.svg / alibabacloud.svg logos
      (volcengine.svg stays; the other logos are still used by the provider
      registry)
    - retarget the LLM-only apply test from the deleted deepseek preset to
      volcengine-ark
    
    * feat(token-plan): restore aggregator/third-party presets
    
    Previous commit over-trimmed: the intent was to drop only the Tencent and
    Bailian token plans, not the OpenRouter/SiliconFlow/DeepSeek/GLM/Qwen
    entries. Bring those back; keep only Tencent/Bailian removed.
    
    - token_plan: MiniMax, 火山方舟 Volcengine Ark
    - aggregator: OpenRouter, SiliconFlow
    - third_party: DeepSeek, GLM, Qwen
    
    Revert the apply test back to the deepseek fixture (restored).
    tencentcloud.svg / alibabacloud.svg stay deleted (their plans are gone).
    
    * fix(token-plan): point Volcengine plan at the Coding Plan endpoint
    
    The plan's ark--prefixed API keys authenticate only against
    /api/coding/v3, not the general /api/v3 endpoint — the latter rejects them
    with "The API key format is incorrect", so model probing returned nothing.
    Switch the base URL to https://ark.cn-beijing.volces.com/api/coding/v3.
    
    * fix(token-plan): Volcengine is an Agent Plan (Anthropic /api/plan)
    
    Per the Ark Agent Plan docs, the ark--prefixed keys authenticate ONLY
    against the dedicated Anthropic-compatible base https://ark.cn-beijing.
    volces.com/api/plan ("其他 Base URL 无法在 Agent Plan 中使用"). The general
    /api/v3 and the Coding Plan /api/coding endpoints both reject the key as
    "API key format is incorrect", which is why model probing kept returning 0.
    
    - baseUrl → https://ark.cn-beijing.volces.com/api/plan/v1 (the /v1 lets the
      Anthropic SDK land on /api/plan/v1/messages)
    - apiFormat → anthropic
    - rename to 火山方舟 Agent Plan
    
    Probe still targets /api/plan/v1/models (the path exists); if the Anthropic
    gateway doesn't return an OpenAI-shaped list, users fall back to typing a
    model id like ark-code-latest.
    
    * fix(token-plan): Volcengine Agent Plan = OpenAI /api/plan/v3 + ark-code-latest
    
    Settled after probing the real key and reading cc-switch's approach:
    - The ark- plan key works on the OpenAI-compatible /api/plan/v3 endpoint
      (chat/completions returns 200); switch apiFormat back to openai.
    - The plan exposes NO /models list (every /api/plan/*/models is 404), which
      is why probing kept returning 0. cc-switch handles this by hardcoding a
      single ark-code-latest (an auto-routing alias valid on any tier) and does
      NOT use AK/SK for model listing — so we do the same.
    - Seed defaultModels: ['ark-code-latest'] only; users add specific ids by hand.
    
    Supporting machinery (kept, general-purpose):
    - applyTokenPlan seeds models from defaultModels instead of wiping to []
    - handleApply uses defaultModels and skips the doomed probe when present
    - drop stray .playwright-mcp/ debug artifacts and gitignore them
    
    * style: fix prettier formatting in usage files
    
    CI runs prettier on the whole repo (prettier . --check); these four files
    predate this branch's formatting pass and tripped the check.
    
    * feat(token-plan): verify Volcengine Agent Plan's published model set
    
    The Agent Plan publishes a fixed model set but exposes no /models endpoint,
    so carry the documented models as CANDIDATES and verify each on apply:
    
    - add verifyModels flag to TokenPlanModalityTarget
    - new /api/provider/probe-chat-models route: sends a minimal chat request per
      candidate (OpenAI /chat/completions or Anthropic /messages) in parallel,
      returns the subset that succeeds; SSRF-guarded, auth-failure short-circuits
    - handleApply gains a verify branch (before the fixed-defaultModels fast path),
      falling back to the seeded list if verification fails
    - Volcengine preset now carries the 12 published Agent Plan text models
      (doubao-seed-2.0-*/deepseek-v4-*/minimax-m*/glm-5.2/kimi-k2.*) as candidates
    
    This auto-prunes retired (docs flag deepseek-v3.2/glm-5.1 as 即将下线) and
    tier-gated models without code changes. Verified all 12 resolve against a real
    plan key.
    
    * feat(token-plan): wire Volcengine Agent Plan image + video modalities
    
    Make the Ark seedream/seedance adapters path-configurable and light up the
    image/video modalities on the Volcengine plan:
    
    - seedream/seedance adapters: resolveArkRoot() uses baseUrl verbatim when it
      already carries an /api/... path (token plan's /api/plan/v3), else appends
      the standard /api/v3 — no regression for the pay-as-you-go default host.
    - applyTokenPlan: image/video branches inject a modality's defaultModels as
      customModels and set them as the active provider+model, so generation works
      out of the box. New optional setImageProvider/ModelId + setVideoProvider/
      ModelId actions (UI passes the store setters; tests omit them).
    - Volcengine preset declares image (doubao-seedream-5.0-lite, verified 200 on
      /api/plan/v3/images/generations) and video (doubao-seedance-2.0/1.5-pro —
      Medium+ tiers only; lower tiers reject at call time, no code change needed
      to upgrade).
    
    Applying the plan overwrites the shared seedream/seedance slot with the plan
    config (same overwrite model as LLM); switching back to pay-as-you-go is a
    manual edit or plan removal. Verified image end-to-end with a real plan key.
    
    * feat(token-plan): verify image/video models on apply, disable unsupported tiers
    
    The Volcengine plan lit up video optimistically, but lower tiers (Small) don't
    include video — so using it 404'd with UnsupportedModel. Probe media models on
    apply and only keep what the tier actually supports:
    
    - generalize /api/provider/probe-chat-models with a `kind` (chat|image|video):
      image hits /images/generations, video hits /contents/generations/tasks with
      empty content. The model-support check (404 UnsupportedModel) runs before any
      billable work, so probing never starts a real image/video job; for media,
      "supported" = any non-404 response.
    - handleApply: after lighting up image/video, probe each verifyModels modality;
      prune to the verified model set + re-select a working model, or disable the
      modality entirely if none pass (no false "available").
    - Volcengine preset: image/video targets gain verifyModels: true.
    - add settings.tokenPlan.tierUnsupported across 8 locales.
    
    Verified with a real Small-tier key: image (seedream-5.0-lite) passes and is
    kept; video (seedance-2.0/1.5-pro) 404s and is disabled.
    
    * feat(web-search): add Doubao (豆包搜索) provider
    
    Doubao Search (Custom 版) over its REST endpoint
    POST open.feedcoopapi.com/search_api/web_search with Bearer auth — the
    same endpoint the askecho-search-infinity MCP server wraps, so the
    Volcengine Agent Plan key authenticates directly. Mirrors the MiniMax
    adapter: maps Result.WebResults to WebSearchSource (prefers Summary, the
    query-relevant excerpt, over Snippet for LLM use) and surfaces errors
    from ResponseMetadata.Error.
    
    - register 'doubao' in WebSearchProviderId + WEB_SEARCH_PROVIDERS
    - searchWithDoubao adapter, searchWeb dispatch, store default config
    - SSRF allowlist entry for the search host
    
    * feat(audio): support Agent Plan single-key auth for Doubao TTS
    
    generateDoubaoTTS now picks auth + endpoint from the key shape, since
    Volcengine exposes Seed-TTS as two products with separate credentials
    (verified: a plan key 401s on the normal endpoint, and the plan endpoint
    rejects appId-style auth):
      - single key (no colon) -> X-Api-Key, for the Agent Plan /plan endpoint
      - appId:accessKey        -> X-Api-App-Id + X-Api-Access-Key (unchanged)
    A malformed pair (empty half) fails clearly instead of sending an empty
    header. Reuses the existing NDJSON/base64-mp3 parsing and voice list.
    
    * fix(media): map MiniMax video 720p to its real 768P tier
    
    normalizeVideoOptions defaults minimax-video to '720p' (the first
    supported resolution), but Hailuo 2.3 only accepts 768P/1080P and rejects
    720P with '2013 ... does not support resolution 720P'. MiniMax's mid tier
    is 768P, not 720P (the adapter already falls back to 768P, as does the
    connectivity test), so map the shared enum's '720p' to 768P. Regression
    tests lock the mapping.
    
    * feat(token-plan): add web search + TTS to Volcengine Agent Plan, widen image tiers
    
    Extend the volcengine-ark preset now that the adapters exist:
      - webSearch -> doubao (own host open.feedcoopapi.com, not the ark endpoint)
      - tts -> doubao-tts on the /api/plan/tts endpoint (single-key auth)
      - image defaultModels widened to a best-first Seedream 5.0/4.5/4.0 list so
        a higher tier keeps the strongest model while verifyModels prunes the
        rest; video keeps the 2.0 + 1.5-pro candidates
    
    Comments record the verified host/auth quirks of each modality.
    
    * feat(token-plan): show result panel only after probing, with two clear states
    
    Addresses review feedback that a green check implied generation works
    when it only meant 'configured'. The panel now renders after probing
    finishes (gated on results && !applying) so it reflects the final set,
    and uses two states: green when the modality is configured/usable, muted
    when a live probe proved it unavailable (e.g. video on a tier without it).
    
    * feat(token-plan): scope presets to true multi-modal token plans
    
    Drop the single-modality LLM presets (OpenRouter, SiliconFlow, DeepSeek,
    GLM, Qwen) from Token Plan. A token plan's defining trait is one key
    spanning many modalities; those entries are ordinary LLM API providers
    already covered by the add-provider flow, and listing them here muddied
    the 'one key, every modality' promise. Only MiniMax and the Volcengine
    Ark Agent Plan remain. The UI already hides categories with no entries.
    
    apply-token-plan's LLM-only test now uses a local fixture instead of the
    removed deepseek preset.
    
    * feat(token-plan): progressive reveal of probe results on apply
    
    The result panel previously rendered all at once after probing finished,
    reading as dead air during the model probe. Now rows appear immediately on
    Apply: modalities with a live probe in flight show a spinner ('pending')
    and resolve to lit/failed independently as each probe returns, while
    non-probe modalities show lit right away. Probes run in parallel
    (Promise.all) instead of sequentially.
    
    A row only turns green once its own probe confirms, so this reveals
    structure + live progress without a premature green — complementing the
    earlier 'render only after probing' intent rather than reverting it.
    
    Per review feedback from @wyuc on #784.
    
    * fix(token-plan): enrich seeded models with built-in thinking capability
    
    Token Plan built ModelInfo objects from probed ids via modelInfoFromId(),
    filling only streaming/tools/vision — so a model that supports configurable
    thinking lost capabilities.thinking and InlineThinkingControl was hidden.
    
    modelInfoFromId now takes an optional providerId and overlays the catalog
    thinking capability for that (provider, model) pair; applyTokenPlan does the
    same for its synchronously-seeded list. Added the Ark Agent Plan's dotted
    aliases to the metadata table:
      - native Doubao Seed 2.0 family (doubao-seed-2.0-pro/code/lite/mini)
      - cross-vendor models the plan serves through its OpenAI-compatible endpoint
        (deepseek-v4-pro/flash, glm-5.2, kimi-k2.7-code/k2.6, minimax-m3/m2.7,
        ark-code-latest)
    
    All verified against a live plan key: each accepts the gateway's unified
    reasoning_effort field (low/medium/high) and actually reasons. They share the
    doubao effort adapter, which disables via 'minimal' (not 'none') — matching
    what the plan endpoint accepts (it rejects reasoning_effort:'none').
    
    Addresses review point #1 from @wyuc on #784.
    
    * Improve token plan capability setup UI
    
    * fix token plan setup flow
    
    * chore: prettier format tts-providers.ts

 .gitignore                                     |   1 +
 app/api/generate/image/route.ts                |   9 +
 app/api/generate/tts/route.ts                  |   9 +
 app/api/generate/video/route.ts                |   9 +
 app/api/provider/probe-models/route.ts         |  64 +++++
 app/api/usage/route.ts                         | 116 +++++++++
 components/generation/media-popover.tsx        |  15 +-
 components/settings/add-provider-dialog.tsx    |  71 ++----
 components/settings/general-settings.tsx       |   4 +
 components/settings/index.tsx                  |  53 +++-
 components/settings/provider-config-panel.tsx  |  77 ++++++
 components/settings/token-plan-settings.tsx    | 332 +++++++++++++++++++++++++
 components/settings/usage-dashboard.tsx        | 263 ++++++++++++++++++++
 components/settings/utils.ts                   |  33 ++-
 lib/ai/llm.ts                                  |  56 ++++-
 lib/ai/model-metadata.ts                       |  25 ++
 lib/audio/tts-providers.ts                     |  42 +++-
 lib/config/apply-token-plan.ts                 | 316 +++++++++++++++++++++++
 lib/config/token-plan-presets.ts               | 212 ++++++++++++++++
 lib/i18n/locales/ar-SA.json                    |  50 ++++
 lib/i18n/locales/en-US.json                    |  50 ++++
 lib/i18n/locales/ja-JP.json                    |  50 ++++
 lib/i18n/locales/ko-KR.json                    |  50 ++++
 lib/i18n/locales/pt-BR.json                    |  50 ++++
 lib/i18n/locales/ru-RU.json                    |  50 ++++
 lib/i18n/locales/zh-CN.json                    |  50 ++++
 lib/i18n/locales/zh-TW.json                    |  50 ++++
 lib/media/adapters/minimax-video-adapter.ts    |   7 +-
 lib/media/adapters/seedance-adapter.ts         |  16 +-
 lib/media/adapters/seedream-adapter.ts         |  16 +-
 lib/server/fetch-with-timeout.ts               |  18 ++
 lib/server/model-fetch.ts                      | 159 ++++++++++++
 lib/server/usage-storage.ts                    | 202 +++++++++++++++
 lib/server/web-search-config.ts                |   1 +
 lib/store/settings-validation.ts               |   2 +-
 lib/store/settings.ts                          | 162 ++++++++++--
 lib/types/provider.ts                          |   7 +
 lib/types/settings.ts                          |   5 +
 lib/usage/normalize.ts                         |  66 +++++
 lib/web-search/constants.ts                    |  10 +
 lib/web-search/doubao.ts                       | 122 +++++++++
 lib/web-search/index.ts                        |   3 +
 lib/web-search/types.ts                        |   2 +-
 public/logos/volcengine.svg                    |   1 +
 tests/audio/doubao-tts.test.ts                 | 116 +++++++++
 tests/config/apply-token-plan.test.ts          | 231 +++++++++++++++++
 tests/config/token-plan-apply-persist.test.ts  |  66 +++++
 tests/media/minimax-video-provider.test.ts     |  75 +++++-
 tests/server/model-fetch.test.ts               |  69 +++++
 tests/server/usage-storage.test.ts             | 174 +++++++++++++
 tests/store/disable-switches-selection.test.ts | 104 ++++++++
 tests/store/settings-validation.test.ts        |  25 ++
 tests/usage/normalize.test.ts                  | 130 ++++++++++
 tests/usage/route.test.ts                      |  41 +++
 tests/web-search/doubao.test.ts                | 156 ++++++++++++
 tests/web-search/index.test.ts                 |  37 +++
 56 files changed, 4031 insertions(+), 99 deletions(-)

commit 8a9cf24a77d4f06315fef11deb6c72284bb2df64
Author: wyuc <wang-yc24@mails.tsinghua.edu.cn>
Date:   Thu Jul 2 08:02:39 2026 -0400

    Update Doubao Seed model catalog (#827)
    
    Closes #826

 lib/ai/model-metadata.ts                  |  4 ++
 lib/ai/providers.ts                       | 28 +++++++++++++
 lib/media/adapters/seedance-adapter.ts    | 15 ++++---
 lib/media/adapters/seedream-adapter.ts    |  1 +
 lib/media/image-providers.ts              |  1 +
 lib/media/video-providers.ts              |  9 +++++
 lib/store/settings.ts                     |  2 +-
 tests/ai/openai-provider.test.ts          | 65 +++++++++++++++++++++++++++++++
 tests/ai/thinking-config.test.ts          | 18 +++++++++
 tests/media/seed-provider-catalog.test.ts | 26 +++++++++++++
 tests/store/settings-server-sync.test.ts  | 10 ++---
 11 files changed, 167 insertions(+), 12 deletions(-)

commit 3b7a0ca0c053134c3605cd100e1d9dff51dde371
Author: jackefn <41247667+jackefn@users.noreply.github.com>
Date:   Thu Jul 2 17:58:58 2026 +0800

    feat(document): add multi-format course material upload (#741)
    
    * feat(document): add multi-format course material upload
    
    * fix(document): support office uploads with mineru cloud
    
    * fix(document): handle mineru cloud office edge cases
    
    * fix(document): align mineru cloud artifact metadata
    
    ---------
    
    Co-authored-by: Yanpeng Wang <yanpg.wang@gmail.com>

 app/api/extract-document/route.ts             | 184 ++++++++++++++++++++++++
 app/generation-preview/page.tsx               |  40 +++---
 app/generation-preview/types.ts               |  42 +++++-
 app/page.tsx                                  |   7 +
 components/generation/generation-toolbar.tsx  |  28 ++--
 lib/document/extractors/pdf.ts                |  36 +++--
 lib/document/extractors/registry.ts           |   8 +-
 lib/document/extractors/text.ts               |  53 +++++++
 lib/document/index.ts                         |   7 +
 lib/document/mime.ts                          |  72 ++++++++++
 lib/document/pdf-compat.ts                    |   6 +-
 lib/i18n/locales/ar-SA.json                   |  13 +-
 lib/i18n/locales/en-US.json                   |  13 +-
 lib/i18n/locales/ja-JP.json                   |  13 +-
 lib/i18n/locales/ko-KR.json                   |  13 +-
 lib/i18n/locales/pt-BR.json                   |  13 +-
 lib/i18n/locales/ru-RU.json                   |  13 +-
 lib/i18n/locales/zh-CN.json                   |  13 +-
 lib/i18n/locales/zh-TW.json                   |  13 +-
 lib/pdf/mineru-cloud.ts                       |  32 +++--
 lib/pdf/pdf-providers.ts                      |  29 ++--
 lib/server/provider-config.ts                 |  18 ++-
 tests/document/extract-document-route.test.ts | 198 ++++++++++++++++++++++++++
 tests/document/extractor-registry.test.ts     |  88 +++++++++++-
 tests/document/mime.test.ts                   |  29 ++++
 tests/document/mineru-cloud.test.ts           | 161 +++++++++++++++++++++
 tests/document/pdf-compat.test.ts             |  25 ++++
 tests/document/text-extractor.test.ts         |  58 ++++++++
 tests/server/provider-config.test.ts          |  26 ++++
 29 files changed, 1152 insertions(+), 99 deletions(-)

commit cd5f997dd28ee581309d1659d8e4ee027240e7e6
Author: Matt Van Horn <mvanhorn@users.noreply.github.com>
Date:   Thu Jul 2 02:44:20 2026 -0700

    docs: document the dev-server OOM workaround for large generations (#808)
    
    Co-authored-by: Matt Van Horn <455140+mvanhorn@users.noreply.github.com>
    Co-authored-by: wyuc <wang-yc24@mails.tsinghua.edu.cn>

 packages/docs/content/docs/getting-started.mdx | 24 ++++++++++++++++++++++++
 1 file changed, 24 insertions(+)

commit 9ffdd72f77c2608868c6d581cff118342dd88bcf
Author: Dustin Persek <dustin.persek@gmail.com>
Date:   Wed Jul 1 23:20:14 2026 -0400

    fix(quiz): render formulas in quiz text (#833)
    
    * fix(quiz): render formulas in quiz text
    
    * fix(quiz): tighten formula rendering heuristics

 components/scene-renderers/quiz-view.tsx |  58 +++++-
 lib/quiz/math-text.ts                    | 310 +++++++++++++++++++++++++++++++
 tests/quiz/math-text.test.ts             | 144 ++++++++++++++
 3 files changed, 503 insertions(+), 9 deletions(-)

commit 9b4746efe92a8257652d4c817c3abc2f8fcabb86
Author: wyuc <wang-yc24@mails.tsinghua.edu.cn>
Date:   Wed Jul 1 06:53:12 2026 -0400

    feat(dsl): activate the migration registry + runner (#787 Part B-2) (#825)
    
    * feat(dsl): activate the migration registry + runner (#787 Part B-2)
    
    `version.ts` was a stub (`DSL_MIGRATIONS = []`, no runner). Fill in the
    document-level migration mechanism, keeping @openmaic/dsl zero-runtime-dep:
    
    - `migrate(doc)` — walks a document from its written `dslVersion` (absent =>
      legacy) up the `DSL_MIGRATIONS` ladder to `DSL_VERSION`, stamping the result.
      Idempotent, forward-compatible (never downgrades a newer doc), fail-loud on a
      broken ladder. Mirrors the app's `migrateSlideContent` philosophy.
    - `dslVersionOf` / `needsMigration` readers; `DslVersioned` envelope type;
      `UNVERSIONED_DSL_VERSION` / `DSL_VERSION_KEY` constants.
    - First ladder entry: a no-op transform stamping legacy docs to the current
      `DSL_VERSION` (0.1.0) — no serialized shape changed in #811/#817, so this
      wires the pipeline end to end without faking a shape bump.
    - `DSL_VERSION` stays 0.1.0 (serialized-contract axis); package minor-bumps to
      0.2.0 for the new API surface. README documents the two independent version
      axes (+ the orthogonal app-side `SlideContent.schemaVersion`).
    - test/version.test.ts: ladder invariants, stamp/idempotence/purity,
      forward-compat, fail-loud.
    
    Closes the migration-registry acceptance box of #787; the app-side wiring of a
    normalized store onto this pipeline remains future work (per the issue's open
    question).
    
    * fix(dsl): pin migration endpoints to literals, not the moving DSL_VERSION
    
    Cross-review (codex, P2): the first ladder entry used `to: DSL_VERSION`. Once a
    future shape change bumps DSL_VERSION and appends a real step, that entry's `to`
    would move too, so legacy docs would be stamped straight to the new version and
    skip the appended transform. Migration endpoints must be immutable.
    
    - add `INITIAL_DSL_VERSION` (pinned '0.1.0' literal); first entry targets it
      instead of the moving `DSL_VERSION` constant.
    - test asserts `DSL_MIGRATIONS[0].to === INITIAL_DSL_VERSION` to guard the intent.
    
    * fix(dsl): validate version stamps + align needsMigration/migrate on non-objects
    
    Addresses cosarah's review on #825:
    
    - Malformed version stamps no longer silently bypass migration. `dslVersionOf`
      now fails loud on a present-but-malformed stamp (e.g. "1", "0.1",
      "0.1.0-beta"), instead of letting `parseVersion` coerce it into a comparable
      value that reads as >= DSL_VERSION. Absent stamp / non-object still map to the
      unversioned baseline. Adds an `isValidVersion` (`x.y.z`) guard.
    - `needsMigration` and `migrate` now agree on non-objects: both treat a
      non-object as "nothing to migrate" (needsMigration -> false, migrate -> input
      unchanged), so `while (needsMigration(x)) x = migrate(x)` can't loop forever.
    
    Tests cover malformed-stamp fail-loud and the non-object agreement invariant.
    
    ---------
    
    Co-authored-by: wyuc <zdq1204@gmail.com>
    Co-authored-by: 杨慎 <117187635+cosarah@users.noreply.github.com>

 packages/@openmaic/dsl/README.md            |  47 ++++++-
 packages/@openmaic/dsl/package.json         |   2 +-
 packages/@openmaic/dsl/src/version.ts       | 191 ++++++++++++++++++++++++++--
 packages/@openmaic/dsl/test/version.test.ts | 116 +++++++++++++++++
 4 files changed, 344 insertions(+), 12 deletions(-)

commit 3f851bbcce48bb956d891ed2367f83b9314c5e97
Author: Matt Van Horn <mvanhorn@users.noreply.github.com>
Date:   Wed Jul 1 02:20:29 2026 -0700

    fix(ai): close PROVIDERS/THINKING_CAPABILITIES metadata drift with a guard (#809)
    
    * fix: close PROVIDERS/THINKING_CAPABILITIES metadata drift with a guard
    
    * fix: use toggle-budget thinking capability for SiliconFlow DeepSeek-V3.2
    
    ---------
    
    Co-authored-by: Matt Van Horn <455140+mvanhorn@users.noreply.github.com>
    Co-authored-by: wyuc <wang-yc24@mails.tsinghua.edu.cn>

 lib/ai/model-metadata.ts        |  2 ++
 tests/ai/model-metadata.test.ts | 63 +++++++++++++++++++++++++++++++++++++++++
 2 files changed, 65 insertions(+)

commit 6d1fd2babbd8114c108a0621ac6898003b61d1cf
Author: ly-wang19 <94427531+ly-wang19@users.noreply.github.com>
Date:   Wed Jul 1 16:51:26 2026 +0800

    fix(export): compute SVG path bounding box via getBounds() (#656)
    
    getSvgPathRange rolled its own bbox by reading x/y off every command and
    defaulting missing coordinates to 0. That:
    - injected a spurious (0,0) for Z/close (no x/y), stretching any glyph that
      doesn't touch the origin;
    - injected a 0 on the missing axis for H/V commands;
    - treated relative-command deltas as absolute coordinates (the parser does
      not normalise to absolute), producing a completely wrong box;
    - ignored arc bulge, giving e.g. a semicircle zero extent on its bulge axis.
    
    These bounds feed the viewBox of the LaTeX -> SVG-image fallback in the PPTX
    export (use-export-pptx.ts), so affected formulas were shifted, clipped, or
    collapsed. Delegate to svg-pathdata's getBounds(), which handles all of the
    above, keeping the empty/malformed -> {0,0,0,0} contract.
    
    Co-authored-by: ly-wang19 <ly-wang19@users.noreply.github.com>
    Co-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    Co-authored-by: wyuc <wang-yc24@mails.tsinghua.edu.cn>

 lib/export/svg-path-parser.ts        | 31 +++++++++++-------------------
 tests/export/svg-path-parser.test.ts | 37 ++++++++++++++++++++++++++++++++++++
 2 files changed, 48 insertions(+), 20 deletions(-)

commit 6fb87e7d0bce9a87470ea155397fa9f08ac1f732
Author: ly-wang19 <94427531+ly-wang19@users.noreply.github.com>
Date:   Wed Jul 1 16:29:38 2026 +0800

    fix(tts): respect string context when splitting the Doubao stream (#677)
    
    Doubao streams a run of concatenated JSON objects with no delimiter. The
    splitter counted `{`/`}` braces without tracking whether it was inside a
    string literal, so a brace in a string value — e.g. an error
    `{"message":"bad {input}"}` — mis-aligned the object boundaries, dropping
    the chunk (lost audio, or a swallowed error).
    
    Extract a string-aware `splitConcatenatedJsonObjects` helper (mirrors the
    scanner in json-repair.ts: tracks inString + escapes) and use it. Behaviour
    is otherwise unchanged: parse failures are skipped, code 20000000 ends the
    stream, rate-limit/error codes still throw.
    
    Closes #676
    
    Co-authored-by: ly-wang19 <ly-wang19@users.noreply.github.com>
    Co-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    Co-authored-by: wyuc <wang-yc24@mails.tsinghua.edu.cn>

 lib/audio/json-stream.ts        | 43 ++++++++++++++++++++++++++++++++++
 lib/audio/tts-providers.ts      | 52 +++++++++++++++++------------------------
 tests/audio/json-stream.test.ts | 41 ++++++++++++++++++++++++++++++++
 3 files changed, 105 insertions(+), 31 deletions(-)

commit eca6811c622e7fd38cbe736bebc98b341162d91a
Author: ly-wang19 <94427531+ly-wang19@users.noreply.github.com>
Date:   Wed Jul 1 15:38:31 2026 +0800

    fix(export): keep sibling attributes when style is empty (#683)
    
    formatAttributes is a reduce; the empty-style branch returned '' instead of
    the accumulator, so every attribute emitted before an empty `style=""`
    attribute was dropped on stringify (e.g. `<div class="x" style=""> -> <div>`).
    Return `attrs` to omit the empty style while keeping the rest.
    
    Closes #682
    
    Co-authored-by: ly-wang19 <ly-wang19@users.noreply.github.com>
    Co-authored-by: wyuc <wang-yc24@mails.tsinghua.edu.cn>

 lib/export/html-parser/stringify.ts |  4 +++-
 tests/export/html-stringify.test.ts | 40 +++++++++++++++++++++++++++++++++++++
 2 files changed, 43 insertions(+), 1 deletion(-)

commit 74ff4ada20f5fa67240fb45e0fac78cd41fa02c5
Author: ly-wang19 <94427531+ly-wang19@users.noreply.github.com>
Date:   Wed Jul 1 15:25:39 2026 +0800

    fix(web-search): match Brave's current result-title markup (#688)
    
    * fix(web-search): match Brave's current result-title markup
    
    Brave moved the web-result title from `<span class="search-snippet-title">`
    to `<div class="… search-snippet-title …">`, so parseBraveSearchHtml hit
    `if (!title) continue` for every snippet and returned 0 results against the
    live page. The existing test stayed green because its fixture still used the
    old <span> markup (drifted from reality).
    
    Accept either <span> or <div> for the title, and update the fixtures to the
    current markup (keeping one legacy <span> case). Verified end-to-end against a
    real search.brave.com scrape: 0 results before, real results after.
    
    Closes #687
    
    * fix(web-search): pair Brave title open/close tags via backreference
    
    Use a backreference (`<(span|div)…></\1>`) so the title's closing tag must
    match its opening tag, per review feedback. Prevents a malformed
    `<span …>…</div>` from being mis-parsed as a title. Title text moves to
    capture group 2; existing matched-tag markup (div and legacy span) is
    unaffected. Adds a regression test for the mismatched-tag case.
    
    ---------
    
    Co-authored-by: ly-wang19 <ly-wang19@users.noreply.github.com>
    Co-authored-by: wyuc <wang-yc24@mails.tsinghua.edu.cn>

 lib/web-search/brave.ts        | 10 ++++++++--
 tests/web-search/brave.test.ts | 29 +++++++++++++++++++++++------
 2 files changed, 31 insertions(+), 8 deletions(-)

commit b6fe2814d2d8517c90b8b42786c04eb67d98d908
Author: Yanpeng Wang <yanpg.wang@gmail.com>
Date:   Wed Jul 1 14:50:15 2026 +0800

    fix(quiz): stop leaking questions on entry and pass results to chat agent (#823)
    
    * fix(quiz): stop leaking questions on entry and pass results to chat agent
    
    Fixes #822.
    
    Two related defects on quiz scenes:
    
    1. The `quiz-actions` opening monologue could enumerate question stems,
       compare options, and trigger a `discussion` action that walked agents
       through the quiz BEFORE the learner had answered anything.
    
    2. After the learner submitted, the chat/discussion agent never saw
       their answers, correctness, the canonical `analysis`, or the
       `aiComment` from `/api/quiz-grade` — so post-quiz feedback was
       generic and often re-explained the whole quiz from scratch.
    
    Changes:
    
    - `lib/prompts/templates/quiz-actions/{system,user}.md`: collapse the
      generator down to a brief 1-2 segment opening, forbid `discussion`
      actions in scene.actions, and add explicit "no preview, no answer,
      no detailed concept re-teach" safety rules.
    - `lib/types/chat.ts` + `lib/chat/agent-loop.ts`: add optional
      `quizResults` to `StatelessChatRequest.storeState` /
      `AgentLoopStoreState` (sceneId + answers + per-question
      status/earned/aiComment).
    - `components/chat/use-chat-sessions.ts`: hydrate `quizResults` from
      `readSubmittedState(sceneId)` once per agent-loop iteration (and on
      initial dispatch) so retries are picked up.
    - `lib/orchestration/summarizers/state-context.ts`: when results are
      present, surface per-question student answer / correct answer /
      verdict / analysis / aiComment with a "address THIS student's
      mistakes" instruction; when unsubmitted, keep question visibility
      for clarifying questions but pin strict no-leak rules so a learner
      saying "I'm done" cannot bait the agent into reciting the quiz.
    
    Discussion / multi-agent round-robin and the canonical session flow
    are untouched.
    
    * style: apply prettier formatting to state-context
    
    ---------
    
    Co-authored-by: wyuc <wang-yc24@mails.tsinghua.edu.cn>

 components/chat/use-chat-sessions.ts           | 52 +++++++++++++++
 lib/chat/agent-loop.ts                         | 16 +++++
 lib/orchestration/summarizers/state-context.ts | 78 ++++++++++++++++++++---
 lib/prompts/templates/quiz-actions/system.md   | 88 ++++++++++----------------
 lib/prompts/templates/quiz-actions/user.md     |  2 +-
 lib/types/chat.ts                              | 19 ++++++
 6 files changed, 189 insertions(+), 66 deletions(-)

commit 6538e718ff84720a7ce3e0cfe60b8a4d3ad773a0
Author: wyuc <wang-yc24@mails.tsinghua.edu.cn>
Date:   Wed Jul 1 02:04:28 2026 -0400

    feat(editor): in-editor authoring of classroom agents (Stage-level roster) (#816)
    
    * feat(editor): agent roster edit operations
    
    Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
    
    * refactor(editor): dedupe agent.delete lookup + cover history cap/color/teacherCount
    
    Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
    
    * feat(editor): materialize agent roster from presets
    
    Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
    
    * refactor(editor): cycle prepended-teacher index + document branch-1 as-is
    
    Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
    
    * feat(editor): stage store viewMode + agent roster persistence
    
    Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
    
    * feat(editor): useAgentRoster controller hook
    
    Implements the AgentRosterController hook that bridges the store, history
    stack, and agent-ops layer for the agents authoring view.
    
    - Materializes roster from stage on mount via materializeRoster + resolvePreset
    - Holds AgentRosterHistory in React state; exposes add/update/remove/reorder
    - Guards LAST_TEACHER errors (caught, no-op) in update + remove
    - Exposes SurfaceHistory-shaped history object for undo/redo wiring
    - Syncs history.present to setStageAgents via useEffect on every change
    
    Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
    
    * feat(editor): Agents view UI components
    
    Adds AgentsView, AgentRosterGrid, AgentCard, AgentInspector, AvatarPicker.
    
    Layout: full-height panel with a scrollable grid of agent cards on the left
    and a fixed inspector panel on the right (opens when a card is selected).
    
    - AgentCard: avatar + name + role badge + persona excerpt; ◀/▶ reorder
      buttons; delete button disabled + titled when canRemove=false (last teacher)
    - AgentRosterGrid: responsive grid with trailing [+ 添加角色] add tile
    - AgentInspector: name input, role select (teacher/assistant/student),
      AvatarPicker over AGENT_DEFAULT_AVATARS, persona textarea capped 2000 chars
    - AvatarPicker: grid of AGENT_DEFAULT_AVATARS with violet selection ring
    - AgentsView: composes the hook + grid + inspector; renders its own
      CommandBar (title="Agents", history=hook.history) with leading/trailing slots
    
    Styling follows quiz surface conventions (rounded-2xl cards, zinc palette,
    violet accent on selection, same FOCUS ring treatment for inputs).
    
    Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
    
    * feat(editor): [Slides]/[Agents] view toggle wired into Pro-mode chrome
    
    - CommandBar: add optional `leading?: ReactNode` center slot for the toggle
    - EditShell/Frame: thread new `commandLeading` prop down to CommandBar
    - EditChromeRoot: read viewMode/setViewMode from useStageStore; build a
      ViewModeToggle ([幻灯片] / [角色] segmented control) passed as commandLeading
      to both EditShell (slides mode) and AgentsView (agents mode)
    - When viewMode==='agents', render AgentsView instead of EditShell; leftRail
      and bottomRail are naturally absent since AgentsView owns its own layout
    - When viewMode==='slides', existing EditShell path is unchanged
    - CommandBar history in agents mode binds to useAgentRoster().history;
      title = "Agents"
    
    Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
    
    * fix(editor): functional state updates in useAgentRoster + last-teacher role feedback
    
    Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
    
    * fix(editor): break infinite render loop in Agents view persistence effect
    
    Remove `stage` from the useEffect dep array in useAgentRoster — setStageAgents
    mutates stage (new object ref), which was triggering re-render → effect → loop
    (React error #185). setStageAgents already no-ops when stage is null
    (lib/store/stage.ts:287), so the `if (stage)` guard is also removed.
    
    Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
    
    * fix(editor): persist agent roster edits to registry + stage snapshot
    
    - Add generatedAgentConfigs to StageRecord (database.ts) so Dexie can
      round-trip it through db.stages.
    - Include generatedAgentConfigs in saveStageData whitelist (stage-storage.ts)
      so editor reloads restore the user's roster edits.
    - In saveToStorage (stage.ts), call saveGeneratedAgents(stageId, configs)
      after the stage snapshot write; this is already debounced (500 ms) via
      debouncedSave, so db.generatedAgents + the in-memory registry are synced
      without writing on every keystroke. saveGeneratedAgents clears-then-
      bulk-inserts, so deleted agents are fully removed from the registry.
    - Add 3 timer-driven tests that verify saveStageData carries
      generatedAgentConfigs and saveGeneratedAgents is called with the
      correct payload after the debounce fires.
    
    Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
    
    * fix(editor): scope agent-registry sync to real roster edits (cross-review)
    
    - FIX A (P1): remove saveGeneratedAgents from shared saveToStorage; add
      dedicated debouncedSaveAgents called only from setStageAgents — scene
      advances (setCurrentSceneId etc.) no longer churn db.generatedAgents
    - FIX B (P2.1): add isDirtyRef guard in useAgentRoster so opening the
      Agents tab without editing does not persist/rewrite the roster; ref is
      set in applyOp, add, undo, redo before any setHistState mutation
    - FIX C (P2.2): coalesce consecutive agent.update ops on the same
      agent+fields into one history entry so undo steps over a whole edit
      rather than each keystroke
    - Tests: add regression guards asserting saveGeneratedAgents is NOT
      called on setCurrentSceneId or plain saveToStorage, IS called after
      setStageAgents (new dedicated debounce path)
    
    Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
    
    * fix(editor): clone preset agents to fresh ids on materialization (cross-review P1)
    
    * refactor(editor): move agent roster into right-rail tab beside Edit with AI
    
    The [幻灯片][角色] top toggle + full-canvas AgentsView swap is replaced
    by a tabbed right rail (RightRailTabs) with "Edit with AI" and "角色"
    tabs. The slide canvas stays visible in all modes; agents are edited in
    the 角色 tab of the right rail.
    
    Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
    
    * feat(editor): restyle agent panel to Design B accordion (课堂阵容)
    
    Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
    
    * fix(editor): cross-review — persona draft sync, scoped preset re-id, AI-tab gating, dead-code cleanup
    
    Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
    
    * fix(editor): avatar click expands card, editable-name affordance, add-button copy
    
    * fix(editor): cross-review — drop blur-level undo coalescing, sync playback selection to edited roster
    
    Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
    
    * style(editor): prettier format agent panel files (CI fix)
    
    ---------
    
    Co-authored-by: Claude Sonnet 4.6 <noreply@anthropic.com>

 components/edit/AgentPanel/AgentPanel.tsx       | 113 +++++
 components/edit/AgentsView/AgentRosterPanel.tsx | 562 ++++++++++++++++++++++++
 components/edit/AgentsView/AvatarPicker.tsx     |  35 ++
 components/edit/AgentsView/useAgentRoster.ts    | 186 ++++++++
 components/edit/EditChromeRoot.tsx              |  65 ++-
 components/edit/RightRailTabs.tsx               | 306 +++++++++++++
 lib/edit/agent-ops.ts                           | 170 +++++++
 lib/edit/agent-roster.ts                        |  58 +++
 lib/store/stage.ts                              |  25 ++
 lib/utils/database.ts                           |  10 +-
 lib/utils/stage-storage.ts                      |   1 +
 tests/edit/agent-ops.test.ts                    | 147 +++++++
 tests/edit/agent-roster.test.ts                 | 152 +++++++
 tests/store/stage-agents.test.ts                | 169 +++++++
 14 files changed, 1964 insertions(+), 35 deletions(-)

commit 7c19ab8f1e3261edf75fe05d9ddc76d16dfd4336
Author: wyuc <wang-yc24@mails.tsinghua.edu.cn>
Date:   Tue Jun 30 13:04:34 2026 -0400

    feat(dsl): JSON Schema artifacts + pure validators (#787 Part B-1) (#817)
    
    * feat(dsl): add ACTION_TYPES set + isActionType guard
    
    A frozen set of every valid ActionType plus a pure membership guard,
    mirroring the PPT_ELEMENT_TYPES / isPPTElementType idiom in guards.ts.
    Used by the new validators; useful standalone for narrowing untrusted
    action.type values.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * feat(dsl): build-time JSON Schema codegen for stage/scene/action
    
    TS types stay the single source of truth; ts-json-schema-generator (a
    devDependency, build-only) emits dist/schema/{stage,scene,action}.schema.json,
    shipped under the new ./schema/* export. Serves non-TS / bring-your-own-validator
    consumers without adding a runtime dependency.
    
    JSON Schema is not generic, so schema-roots.ts provides a concrete
    Scene<Action, SceneContent> entry point (kept internal, not re-exported).
    schema.test.ts compiles the generated schema with ajv (devDep) to prove the
    artifact is real and self-contained on a clean checkout.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * feat(dsl): add pure structural validators (stage/scene/action)
    
    validateStage / validateScene / validateAction: hand-written, zero-dependency,
    fail-loud structural checks layered on the existing guards. They verify
    discriminants, required fields, and known nested discriminants — a gate for
    untrusted input (LLM/agent output) and persistence boundaries. Exhaustive
    per-field validation is delegated to the shipped JSON Schema. Error-collecting
    ValidationResult reports every issue with a JSON-pointer-ish path.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * docs(dsl): document the runtime schema + validator layer
    
    Add a Runtime layer section covering the two complementary consumption modes
    (schema-as-data via @openmaic/dsl/schema/* and the zero-dep validate* gate),
    the validate.ts module row, the build:schema step, and tick the JSON Schema
    roadmap box.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * fix(dsl): harden validators per cross-review (exhaustiveness, discriminant agreement)
    
    Addresses cross-review findings on the validator layer:
    
    - Add compile-time exhaustiveness assertions for ACTION_TYPES and SCENE_TYPES.
      `satisfies` only proved each entry is valid, not that the tuple covers the
      whole union — a newly-added Action/Scene variant could silently be rejected
      by the validators. The assertion now fails the build on drift.
    - validateScene cross-checks that scene.type agrees with content.type; a
      slide-typed scene carrying quiz content (or vice versa) is now rejected.
    - Move SCENE_TYPES + add an isSceneType guard to stage.ts, next to SceneType,
      matching the PPT_ELEMENT_TYPES / isPPTElementType idiom in guards.ts; validate.ts
      reuses them instead of re-encoding the union locally.
    - Make the validators' scope honest in the doc comment + README: they check the
      structural envelope, known discriminants, and scene/content agreement; they do
      NOT exhaustively check per-variant fields, and app-side interactive/pbl content
      is validated only at the envelope level (exhaustive checks → the JSON Schema).
    - Note the contract-owned content scope in schema-roots.ts.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * perf(dsl): reuse one schema generator + harden direct-invocation guard
    
    Addresses cross-review findings on the codegen path:
    
    - gen-schema.mjs built a fresh ts-json-schema-generator (full TS program parse)
      per root type; build one generator over the tsconfig program and reuse it for
      every createSchema call — parses once, identical per-type output.
    - Harden the `invoked directly` check to compare realpaths, so a symlinked
      invocation (bin shim / pnpm link) still runs main() instead of silently
      emitting no schema.
    - schema.test.ts generates all roots once at module scope, then only compiles
      per case — no repeated heavy codegen.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * fix(dsl): bind scene schema discriminants + pin node-20-compatible generator
    
    Addresses round-2 cross-review (codex) findings:
    
    - scene.schema.json now ties scene `type` to the matching `content.type`.
      SerializedScene became a discriminated union (SlideScene | QuizScene via
      `Omit<Scene<…>, 'type'> & { type }`), so the generator emits a const-narrowed
      discriminant per branch. Previously the schema accepted e.g.
      { type: 'quiz', content: { type: 'slide', … } } even though validateScene
      rejects it — the schema is now consistent with the validator. Locked with a test.
    - Pin ts-json-schema-generator to ~2.4.0. ^2.3.0 resolved to 2.9.0, which
      declares `node >=22`, conflicting with the repo's `engines.node >=20.9.0`;
      2.4.x supports node >=18, keeping the build runnable on every supported Node.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * style(dsl): prettier formatting + drop unused ts-expect-error for green CI
    
    - Apply repo Prettier (`pnpm check`) formatting to the new/edited files.
    - Remove the `@ts-expect-error` on the gen-schema.mjs import: the root
      `tsc --noEmit` (which compiles test files; allowJs infers the .mjs exports)
      flagged it as an unused directive (TS2578). Plain comment retained.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * refactor(dsl): align validators + schema to the public Scene type (review)
    
    Addresses cosarah's review: the validator, the JSON Schema, and the public TS
    type had drifted into three different notions of a valid scene. Realign them so
    the TS types stay the single source of truth, and position the two runtime
    layers honestly.
    
    - schema-roots.ts: revert SerializedScene to the plain default Scene<Action,
      SceneContent>. The schema no longer encodes a stricter type/content binding
      that the public Scene type doesn't express (the constraint had effectively
      moved into a hidden internal type).
    - validate.ts: drop the scene.type<->content.type agreement check (the public
      Scene does not bind them, so neither does the validator); restrict content to
      the contract-owned kinds (slide/quiz), matching SceneContent and the schema,
      so validator and schema no longer disagree on interactive/pbl content.
    - Reposition docs (validate.ts header + README): the JSON Schema is the
      authoritative, exhaustive per-field validator (it checks variant fields like
      an action's elementId) for trust boundaries; validate* are a cheap,
      zero-dep structural pre-check and a strict subset of the schema — not a
      separate or stricter gate.
    - Tests updated to lock the realigned behavior.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * refactor(dsl): bind scene type<->content in the public Scene contract (review)
    
    cosarah's review showed the scene type<->content agreement is a real, load-bearing
    invariant: consumers branch on `scene.type` and then read `scene.content` as the
    matching shape (e.g. `stage-api-canvas` casts `content as SlideContent` after a
    `scene.type === 'slide'` check; `complete-summary` counts by `scene.type` and reads
    `content as QuizContent`). A validator/schema that blesses mismatched pairs is unsafe.
    So tighten the *exported* contract rather than loosening the runtime checks to match
    a hole — and make the pure validators the authoritative, relied-upon boundary.
    
    DSL contract:
    - `Scene` becomes a distributive discriminated type binding `type` to `content['type']`
      (`SceneCore<TAction> & { type: TContent['type']; content: TContent }` distributed over
      TContent). TS itself now rejects mismatched scenes; generic widening still works.
      Extract `SceneCore` for the kind-independent fields.
    - `validateScene` re-establishes the type<->content agreement check; scene `type` is
      the contract's slide/quiz; `scene.schema.json` (from the spelled-out discriminated
      `SerializedScene`) binds `type` to content per branch. Type, validator, and schema
      now describe the same thing.
    - `validateAction` checks each variant's required fields (e.g. spotlight.elementId,
      discussion.topic) — closes the false-positive gap. A test pins the hand map to the
      generated schema (the TS-derived source of truth) so it cannot drift.
    - Reposition docs: `validate*` is the zero-dep in-process boundary producers rely on;
      the JSON Schema is the cross-language mirror + exhaustive value checker.
    
    App consumers (the sites the discriminated Scene exposes):
    - Add `ScenePatch` (non-distributive partial) + `makeScene(core, content)` helper to
      lib/types/stage.ts — one isolated cast, type derived from content. Patch-typed
      signatures (`updateScene`, `applyScenePatchInSync`, regenerate plan) and scene
      rebuilds (`stage-api-scene`, store `updateScene`, `migrateScene`, stage-storage
      deserialize) route through these. Closes two latent desync foot-guns.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * fix(dsl): validate action field types + migrate scene.update; bidirectional drift-guard (review)
    
    Round-2 review of the contract-tightening change (codex + Claude):
    
    - validateAction now checks each variant-required field's TYPE, not just presence
      (`{ type:'spotlight', elementId: 123 }` is rejected — elementId must be a string).
      ACTION_REQUIRED_FIELDS carries a runtime kind per field.
    - The schema lockstep test is now bidirectional and type-aware: it asserts a
      fully-typed action is accepted (catches the map OVER-listing an optional field),
      every required field flags when missing (under-listing), and flags when present
      but mis-typed — all keyed off the generated schema's field names + types.
    - Migrate the public `stageApi.scene.update()` to ScenePatch + makeScene (the
      create() path was done last commit; update() still did a raw spread that could
      desync type<->content — masked from tsc only because StageStore.setState is typed
      `any`). Now both public scene-construction paths rebind type to content.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * fix(api): keep scene.create's params.type authoritative over content.type (review)
    
    cosarah's review: `CreateSceneParams` exposes an independent `type` plus
    `content?: Partial<SceneContent>`, and after switching create() to makeScene()
    (which derives the scene kind from content.type), a call like
    `create({ type: 'slide', content: { type: 'interactive', ... } })` would silently
    become an interactive scene — params.type ignored — and mix slide defaults into it.
    
    Reject a `content.type` that disagrees with `params.type`, and pin the merged
    content's `type` to `params.type` so a partial content override can't flip the
    scene's discriminant. params.type stays authoritative. Adds a test both ways.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    ---------
    
    Co-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

 lib/agent/client/apply-regenerate.ts          |   6 +-
 lib/agent/client/apply-slide-content.ts       |   4 +-
 lib/api/stage-api-scene.ts                    |  49 +++---
 lib/edit/slide-schema.ts                      |  10 +-
 lib/store/stage.ts                            |  21 ++-
 lib/types/stage.ts                            |  37 +++++
 lib/utils/stage-storage.ts                    |   7 +-
 packages/@openmaic/dsl/README.md              |  61 +++++++-
 packages/@openmaic/dsl/package.json           |  10 +-
 packages/@openmaic/dsl/scripts/gen-schema.mjs |  61 ++++++++
 packages/@openmaic/dsl/src/action.ts          |  38 +++++
 packages/@openmaic/dsl/src/index.ts           |   7 +-
 packages/@openmaic/dsl/src/schema-roots.ts    |  24 +++
 packages/@openmaic/dsl/src/stage.ts           |  91 +++++++----
 packages/@openmaic/dsl/src/validate.ts        | 208 ++++++++++++++++++++++++++
 packages/@openmaic/dsl/test/schema.test.ts    | 133 ++++++++++++++++
 packages/@openmaic/dsl/test/validate.test.ts  |  94 ++++++++++++
 pnpm-lock.yaml                                | 102 ++++++++++++-
 tests/api/stage-api-scene.test.ts             |  41 +++++
 tests/edit/slide-defaults.test.ts             |   4 +-
 tests/edit/slide-schema.test.ts               |   8 +-
 21 files changed, 930 insertions(+), 86 deletions(-)

commit 5daf3e5a6ebf6890a0f6c9ec39ef90e22dcfd467
Author: wyuc <wang-yc24@mails.tsinghua.edu.cn>
Date:   Tue Jun 30 05:57:26 2026 -0400

    fix(editor): keep emptied/zero-action scenes playable, bind outline by stable id, surface incomplete content (#814)
    
    Editor empty-state robustness: dwell on zero-action scenes (engine + PlaybackChromeRoot) so emptied/blank slides stay playable; bind a scene's outline by stable outlineId (reorder/insert/duplicate-safe, allOutlines in scene order); clear the cue preview on glyph unmount; surface incomplete content calmly (amber dashed frame on clips, amber dot on blank outline titles + rail, neutral N/M-ready generate gate). Cross-reviewed (Codex + Claude), 5 rounds to a clean pass.

 components/edit/ActionsBar/ActionsBar.tsx          | 45 +++++++---
 components/edit/PlaybackChromeRoot.tsx             | 12 ++-
 components/edit/SlideNavRail/ThumbItem.tsx         | 11 +++
 components/generation/outlines-editor.tsx          | 39 ++++++++-
 lib/agent/client/resolve-scene-outline.ts          | 30 +++++++
 lib/agent/client/use-agent-runtime.ts              | 29 +++----
 lib/api/stage-api-scene.ts                         |  1 +
 lib/api/stage-api-types.ts                         |  2 +
 lib/edit/content-validation.ts                     | 74 +++++++++++++++++
 lib/edit/scene-creation-enabled.ts                 |  7 +-
 lib/edit/slide-defaults.ts                         | 17 ++--
 lib/generation/scene-builder.ts                    | 20 ++++-
 lib/generation/scene-generator.ts                  |  4 +
 lib/i18n/locales/ar-SA.json                        |  7 +-
 lib/i18n/locales/en-US.json                        |  7 +-
 lib/i18n/locales/ja-JP.json                        |  7 +-
 lib/i18n/locales/ko-KR.json                        |  7 +-
 lib/i18n/locales/pt-BR.json                        |  7 +-
 lib/i18n/locales/ru-RU.json                        |  7 +-
 lib/i18n/locales/zh-CN.json                        |  7 +-
 lib/i18n/locales/zh-TW.json                        |  7 +-
 lib/playback/engine-cursor.ts                      | 64 +++++++++++++++
 lib/playback/engine.ts                             | 21 ++---
 lib/types/stage.ts                                 | 13 ++-
 tests/edit/content-validation.test.ts              | 95 ++++++++++++++++++++++
 tests/edit/slide-defaults.test.ts                  | 11 +++
 .../lib/agent/client/resolve-scene-outline.test.ts | 56 +++++++++++++
 tests/lib/playback/engine-cursor.test.ts           | 95 ++++++++++++++++++++++
 28 files changed, 631 insertions(+), 71 deletions(-)

commit b516427d272364f07cc54e5eb9c8a66278e827b3
Author: ly-wang19 <94427531+ly-wang19@users.noreply.github.com>
Date:   Tue Jun 30 17:15:01 2026 +0800

    perf(generation): index assigned images by id in fixElementDefaults (#701)
    
    fixElementDefaults looked up each image element's metadata with
    assignedImages.find inside the per-element map, making the pass
    O(elements × images). Build a Map<id, image> once and use an O(1)
    Map.get lookup instead. Behavior is identical (Map.get returns the same
    entry as the find), so it's purely a lookup-mechanism swap.
    
    Closes #700
    
    Co-authored-by: ly-wang19 <ly-wang19@users.noreply.github.com>
    Co-authored-by: wyuc <wang-yc24@mails.tsinghua.edu.cn>

 lib/generation/scene-generator.ts | 7 ++++++-
 1 file changed, 6 insertions(+), 1 deletion(-)

commit 19ff0cef42a42b112256ba767d4669578e98bc3c
Author: ly-wang19 <94427531+ly-wang19@users.noreply.github.com>
Date:   Tue Jun 30 16:59:00 2026 +0800

    fix(export): convert PPTX shadow offset from px to pt (#679)
    
    getShadowOption converted the shadow blur from px to pt but left the offset
    in px. pptxgenjs expects both in points (ratioPx2Pt = 96/72 × viewportSize/960),
    so shadows exported ~33% too far from their element at the default viewport
    while the blur radius was correct. Divide the offset by ratioPx2Pt like blur.
    
    Closes #678
    
    Co-authored-by: ly-wang19 <ly-wang19@users.noreply.github.com>
    Co-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    Co-authored-by: wyuc <wang-yc24@mails.tsinghua.edu.cn>

 lib/export/use-export-pptx.ts | 5 ++++-
 1 file changed, 4 insertions(+), 1 deletion(-)

commit a3f88d53e5a9beae74cfce3f7a6c769276ad7029
Author: ly-wang19 <94427531+ly-wang19@users.noreply.github.com>
Date:   Tue Jun 30 16:50:07 2026 +0800

    fix(mathml2omml): call includes() instead of indexing it (#681)
    
    parse.js used `textContainerNames.includes[arr[level].name]`, which reads a
    property of the includes function (always undefined) instead of calling it,
    so the "trailing text node" branch never ran and trailing text inside a
    MathML text container (mtext/mi/mn/mo/ms) was dropped from the OMML. Line 48
    of the same file already uses the correct `includes(...)` form.
    
    dist/ is gitignored and rebuilt by postinstall, so the runtime bundle picks
    up the fix on install.
    
    Closes #680
    
    Co-authored-by: ly-wang19 <ly-wang19@users.noreply.github.com>
    Co-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    Co-authored-by: wyuc <wang-yc24@mails.tsinghua.edu.cn>

 packages/mathml2omml/src/parse-stringify/parse.js | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

commit b122ca30d3e8b9f2cf534aefed4e7e8a67a30b5f
Author: wyuc <wang-yc24@mails.tsinghua.edu.cn>
Date:   Mon Jun 29 23:38:28 2026 -0400

    feat(dsl): bring the Action playback verbs into @openmaic/dsl (#787)
    
    Promote the Action contract (Action union + variants, ActionType, the action-category lists, PercentageGeometry) into @openmaic/dsl/src/action.ts, zero-runtime-dep. Widget interaction actions graduate into the contract; Scene<TAction> defaults to the standard Action union; lib/types/action.ts becomes a re-export shim. Part A of #787 (Phase 2 under #720).

 lib/types/action.ts                       | 330 ++++--------------------------
 packages/@openmaic/dsl/README.md          |  39 ++--
 packages/@openmaic/dsl/src/action.ts      | 292 ++++++++++++++++++++++++++
 packages/@openmaic/dsl/src/index.ts       |  12 +-
 packages/@openmaic/dsl/src/stage.ts       |  33 +--
 packages/@openmaic/dsl/test/stage.test.ts |  23 ++-
 6 files changed, 402 insertions(+), 327 deletions(-)

commit 261fddb062fc0f9f4c938514e578a7e0edd4b5ae
Author: xuyuanwei678 <71585589+xuyuanwei678@users.noreply.github.com>
Date:   Mon Jun 29 16:52:03 2026 +0800

    fix(packages): add openmaic repository metadata (#813)
    
    * fix(packages): add openmaic repository metadata
    
    * ci(packages): publish on openmaic manifest changes

 .github/workflows/publish-packages.yml   | 7 +++++++
 packages/@openmaic/dsl/package.json      | 5 +++++
 packages/@openmaic/importer/package.json | 5 +++++
 packages/@openmaic/renderer/package.json | 5 +++++
 4 files changed, 22 insertions(+)

commit 0bcab10b83861ec822ce86e733ec398814d93212
Author: wyuc <wang-yc24@mails.tsinghua.edu.cn>
Date:   Mon Jun 29 04:33:22 2026 -0400

    fix(lecture-notes): render interactive-webpage widget actions in notes area (#810)
    
    Interactive-webpage scenes (SceneType 'interactive') emit four widget_*
    action types — widget_highlight, widget_setState, widget_annotation,
    widget_reveal — each typically followed by a speech action. These execute
    correctly on stage during playback but were dropped from the Lecture Notes
    timeline due to two compounding gaps:
    
    1. chat-area.tsx built lectureNotes with an allowlist that only admitted
       speech/spotlight/laser/play_video/discussion, filtering out all widget_*
       types so they never entered the notes data.
    2. lecture-notes-view.tsx ACTION_ICON_ONLY had no entries for widget_*, and
       unknown types render as null, so even with data they would be invisible.
    
    Add the four widget_* types to the allowlist and extend ACTION_ICON_ONLY with
    icon/style entries (Highlighter/SlidersHorizontal/StickyNote/Eye), reusing the
    existing inline icon-only badge pattern already used by spotlight/laser.

 components/chat/chat-area.tsx          |  6 +++++-
 components/chat/lecture-notes-view.tsx | 32 +++++++++++++++++++++++++++++++-
 2 files changed, 36 insertions(+), 2 deletions(-)

commit 72e3ef04d77991041f327a13fc04b76d33114220
Author: xuyuanwei678 <71585589+xuyuanwei678@users.noreply.github.com>
Date:   Mon Jun 29 16:22:13 2026 +0800

    chore(packages): set openmaic package versions to 0.0.2 (#812)
    
    Co-authored-by: wyuc <wang-yc24@mails.tsinghua.edu.cn>

 packages/@openmaic/dsl/package.json      | 2 +-
 packages/@openmaic/importer/package.json | 2 +-
 packages/@openmaic/renderer/package.json | 2 +-
 3 files changed, 3 insertions(+), 3 deletions(-)

commit b93434ae2c3c8e1ea73d616253061dd533c99b00
Author: wyuc <wang-yc24@mails.tsinghua.edu.cn>
Date:   Sun Jun 28 23:08:23 2026 -0400

    feat(agent-edit): multi-session conversation history for the AI editor (#801)
    
    * feat(agent-edit): multi-session conversation history for the AI editor
    
    The "Edit with AI" panel kept only one thread per stage in localStorage, and
    "New conversation" deleted it, so previous conversations were unrecoverable.
    
    Add a per-stage session list backed by IndexedDB (Dexie v12 `agentEditSessions`):
    
    - "New conversation" now archives the current session and starts a fresh one
      instead of deleting it; a history popover in the panel header lists past
      sessions (auto-titled from the first user message) to switch back to or delete.
    - One-time migration of the existing single-thread localStorage entry.
    - The active session id is remembered per stage so a refresh restores it,
      including a just-cleared empty session (clean slate survives reload).
    - saveSession preserves the original createdAt and tombstones deleted ids so an
      in-flight save can't resurrect a deleted session; switching stages drops the
      previous thread synchronously so it can't leak into the new stage.
    - Sessions are pruned to a soft cap per stage and removed when a course is
      deleted.
    - i18n for all 8 locales; unit tests for title derivation and the store.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    * fix(types): drop redundant Window.SpeechRecognition augmentation conflicting with @assistant-ui/core
    
    @assistant-ui/core's speech adapter declares Window.SpeechRecognition and
    webkitSpeechRecognition globally as SpeechRecognitionConstructor. Three files
    (prompt-input, use-audio-recorder, use-browser-asr) re-declared them as `any`,
    which conflicts (TS2717) once that adapter's types are pulled into the program,
    and the constructed instance then lacks the event handlers the code sets
    (TS2339/2551). Rely on the global declaration and cast the instance to the local
    rich shape. Takes `tsc --noEmit` back to zero.
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    
    ---------
    
    Co-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

 components/ai-elements/prompt-input.tsx            |  17 +-
 components/edit/AgentPanel/AgentPanel.tsx          |  76 +++++-
 components/edit/EditChromeRoot.tsx                 |   5 +
 lib/agent/client/agent-edit-session-types.ts       |  35 +++
 lib/agent/client/agent-thread-store.ts             | 182 +++++++++++---
 lib/agent/client/use-agent-runtime.ts              | 271 +++++++++++++++++----
 lib/hooks/use-audio-recorder.ts                    |  19 +-
 lib/hooks/use-browser-asr.ts                       |   9 +-
 lib/i18n/locales/ar-SA.json                        |   4 +
 lib/i18n/locales/en-US.json                        |   4 +
 lib/i18n/locales/ja-JP.json                        |   4 +
 lib/i18n/locales/ko-KR.json                        |   4 +
 lib/i18n/locales/pt-BR.json                        |   4 +
 lib/i18n/locales/ru-RU.json                        |   4 +
 lib/i18n/locales/zh-CN.json                        |   4 +
 lib/i18n/locales/zh-TW.json                        |   4 +
 lib/utils/database.ts                              |  24 +-
 .../agent/client/agent-edit-session-types.test.ts  |  41 ++++
 tests/lib/agent/client/agent-thread-store.test.ts  | 189 ++++++++++++--
 19 files changed, 772 insertions(+), 128 deletions(-)
