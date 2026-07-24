6287ae23 PR3: 生成超时机制（单页 3min + 整体 15min）
8b70ad9a PR2: 生成过程实时进度 UI（每个 outline 状态可见）
ac91244e PR1: 生成完成后自动保存到云端（fire-and-forget）
bfe7cae3 i18n: 修正老师主页文案位置（误改回滚 + 重新分配）
1b1163df e2e: 更新 home page enterButton fallback 文案
0f345176 i18n: 老师主页文案改为老师视角
233606f7 docs: SQL 类型注释 — profiles.id / students.user_id 都是 uuid，不强转
ecc21bb4 security: RLS 加固 + AI 生成接口防刷 + 分享页二次验证
fb9a36b3 chore: 顺序问题收尾 — saveStageData 字段白名单补漏 + 左侧导航防御性注释
ecb8a70d refactor: 把 createdAt 改回一次性 repair 工具，seq 回归长期可信
598ac5d0 fix: 所有 IndexedDB 读 scene 路径强制 prefer='createdAt' — 不让中毒 seq 复活
2878bdd5 fix: orderSceneRecordsForDisplay 支持 prefer=createdAt，强制忽略中毒 seq
43611ac0 fix: schema v14 重新恢复 seq + repairOrder=createdAt 临时入口
4d1dbb3a fix: collectStageData 用 sortBy('seq') — 修复上传到云端时 scenes 数组被 nanoid 字典序打乱
7fe96285 refactor: 教师端首页最小可用重构 — 解决"两个我的课程"和按钮文案混乱
aa3d6cdc fix: 引入 seq 字段作为可信展示顺序 — 彻底解决 view 页乱序
4fa0c644 fix: 完全移除 order 排序 — 始终使用 rawScenes 原始数组顺序
dde9817f fix: 移除无条件 order 排序 — 改为安全排序工具函数防止课程顺序被打乱
28eb5193 fix: 初始场景定位错误 — share/打开/学习入口强制从第一页开始
3473b7f9 chore: 添加微信站长认证验证文件
4b4fbd1e refactor(mobile): 切换为 audioSegments 连续播放方案（替代 Uint8Array concat）
ec347d0b fix(mobile): 整章旁白 TTS 改为分块生成（修复"TTS 返回数据缺失"导致保存失败）
e4f717e8 refactor(mobile): 整章音频改用 scene 级 narrationAudioUrl 字段（不污染 speechAction.audioUrl）
2c4e7db8 fix(mobile): 发布时为每章生成完整合并音频（修复只播第一段问题）
5497362c diag(mobile): 移动端音频播放器完整诊断日志
41832fef fix: 移除 StudentGate 访问码弹门（已被 Supabase Auth 账号体系替代）
7d732314 fix(mobile): 分享链接场景下管理员/教师也跳转移动端 + 分享链接补 ?share=1
8915abec fix(mobile): 管理员/教师页面不触发移动端自动跳转 /m
16629b5a fix(mobile): 补齐发布链路/播放路径/校验的缺失日志标签
71c0c0ff fix(mobile): 发布时 Tier 3 TTS 优先使用 stage.teacherVoiceConfig
528251d9 feat(mobile): 移动端播客式学习页第一阶段
746b150c chore(debug): log stage.teacherVoiceConfig on playback mount to diagnose prod
6cf27df9 fix(audio): persist teacher voice at course creation and apply to Q&A path
6ae715dd feat(docs): refresh product-intro.html with Feishu Miaoda design
22bab0b9 fix(types): drop request.messages and msg.content reads; coerce through unknown
91470671 fix(qa): wire currentQAQuestion through state; stabilize client→server messages
75bc3897 fix(qa): teacher closing round after peers + ban slide-narration openers
39d54b07 fix(qa): multi-peer roundtable + suppress 'Your turn' cue + voice chain + prompt tuning
a2bd7e3d feat(qa): let a peer chime in after the teacher answers, then hand off
c552ffee fix(qa): sandwich Q&A prompt and de-prime lecture cues
077d92b9 fix(qa): route multi-agent Q&A to agent_generate instead of skipping it
2755e48c fix(qa): prepend Q&A preamble to full prompt instead of replacing it
753f6e66 fix(qa): wire sessionType through OrchestratorState so isUserQA fires reliably
77b6b20b fix(roundtable): completely replace prompt in Q&A mode, don't append
a682cbc7 fix(mobile): let admin / teacher browse /m without a student-row binding
fda28ddb fix(mobile): auto-generate TTS for chapters without pre-rendered audio
90372253 fix(mobile): paragraphs + sticky bottom dock + autoplay next chapter
c97c8583 feat(mobile): /m/[id] mobile learner surface (Phase 1)
2ce0c1de chore(docs): remove mobile PRD from public serving
236b81f0 docs: mobile PRD v1.0 — locked for Phase 1 development
8f465fa4 docs(public): add 3 screenshots and replace image placeholders
e81171e7 docs(public): update product intro with finalized copy from Feishu wiki
6533dcea chore(scripts): add sync-public-docs helper
32d4b40c fix(docs): mirror public-facing HTML to public/docs for Vercel serving
69d35a3e docs: user manual HTML for public sharing
19894c73 docs: add public-facing product intro (HTML + Markdown)
67d98790 fix(prompt): drop 2-3 sentence cap in Q&A mode
e88c55ca fix(director): emit cue_user after agent turn in Q&A mode
f74faec7 fix(director): Q&A mode = single teacher turn, no multi-agent loop
02bd0d97 fix: strip prior narration in Q&A + always-visible share toast
016511fd feat(library): split into '我的课程' (mine) and '云端课程' (discover)
7f14436a fix: stronger Q&A directive + hide save button in view mode
248447bf fix(roundtable): skip slide details + force direct answer in Q&A mode
7ef2394e fix(tts): override browser-native-tts to server TTS on every sync
6661ed76 fix(roundtable): teacher answers directly without re-narrating slide
ffd1e77e fix(classroom): show save-to-cloud button based on role, not URL
ca955108 feat(theme): purple → green primary + rename '最近学习' → '我的课程'
b54d7eeb feat(rls): wave 3-5 — all learning APIs to service_role + drop anon SELECT
fc2b1d68 feat(rls): wave 2 — enable RLS on courses + API routes to service_role
9b99e5fa fix(classroom): add authReady to loadClassroom deps so it re-fires
6fa5cac5 fix(classroom): move auth gate after all hooks to fix React #310
1b2465fa fix(classroom): Supabase Auth gate replaces ACCESS_CODE modal
30818243 fix(teacher): precise email-collision copy in create-teacher API
89a75569 fix(ts): add 'teacher' to UserRole + cast invite payload to error variant
11db21e0 fix(invite): drop errorCode access to satisfy TS union narrowing
d1ee10fe fix(admin): drop stale access_code from create-student SuccessPayload
e5b3d562 docs(DEV): redact Supabase service_role key from environment template
16060a43 docs: PRD + DEV hand-off documents
ce138bb6 feat(rls): wave 1 SQL — revoke anon write on learning tables
07add04a fix(playback): strip isMaicEditorEnabled gate + restore share button
81801f85 fix(admin): move disable/enable routes under [id]/ + show precise error copy
d014ef1f fix(classroom): EditChromeRoot hook order + cache-bust post-create nav
d6cc1da3 fix(classroom): gate Pro Mode and '保存到云端' on URL, not just env flag
0b7bdfd3 fix(admin): better email-collision copy + force page refresh after create
94192f44 fix(share): drop access_code from learner entry + remove learning-manager UI
66978b7f fix(sql): make role enum + disabled_at migration idempotent
73376469 feat(roles): add teacher role + roster page + drop assignments gate
0770f93b feat(admin): /admin/courses course roster with read-only preview
eb0ebd19 fix(admin): drop access_code from create flow + revalidate on success
98684c15 feat(admin): one-shot create-student + soft-disable + learner-side gate
be4ac1cc feat(schema): add students.disabled_at for soft-delete
1de4e160 fix(create-account-row): open fragment around form + DeleteArchiveButton
e77e461d feat(admin): delete student archive (row + auth.users) from the roster
93f6eee6 fix(admin): keep the initial-password card visible until admin closes it
bfc40828 feat(admin): reset password + unbind controls on bound students
7e8365f9 fix(student): redirect admins away from /student/courses
1c129e75 fix(auth): use createBrowserClient so the session is cookie-based
1b983adf fix(auth): force full-page navigation after sign-in
396ba3ec feat(admin): /admin hub landing page
f2bd25e8 fix(auth): hardcode seed admin email in trigger body
f8e69cf9 docs(invite): clarify that accounts are admin-provisioned
d0975aab feat(admin): student management page + create-account API
c3b7de58 refactor(auth): remove self-registration from login
d32aa9ce chore(deps): add @supabase/ssr for cookie-aware server clients
f30b64af feat(auth): /student/courses shows assigned courses for the learner
d99d963d feat(auth): /invite binds a signed-in user to a student access_code
74563ac7 feat(auth): POST /api/access-code/redeem
e5e62ab2 refactor(auth): use top-level createClient import for service-role client
42e067ac feat(auth): server-side supabase clients (cookie + service_role)
45dc75a7 refactor(auth): rely on DB trigger for profile creation
f6b4474c feat(auth): add handle_new_user and upgrade_seed_admin triggers
8850b015 feat: add auth role foundation
b91967e1 fix: expose token plan model lists
a31cdc9d feat: support server-managed token plan
f856ee35 fix: recognize server provider without explicit model list
46b3c1eb fix: resolve cloud sync scene type mismatch
60160207 Merge pull request #2 from zquanjin-wq/fix-publish-local-audio-url
39beebf5 docs: record audio cloud publish implementation
4fffd082 feat: publish local speech audio assets when saving course to cloud
168467da Merge pull request #1 from zquanjin-wq/fix-cloud-audio-share
18e768ed fix: avoid duplicate TTS generation when saving courses
616d6204 fix: preserve generated agent names and hydrate agents on cloud course load
7adf83fa fix: localize all 6 agent persona descriptions to Chinese
040da942 fix: Chinese agent names and auto-enable TTS for learner view
37409dd1 fix: localize StudentGate to Chinese
bc11f9c0 fix: add RLS policies for learning tables
79bb20a5 fix: surface learning errors and backfill student access codes
c4fc81d5 chore: update laixue logos and favicon
054fbefb fix: add access_code to StudentRecord type
3d57c9d0 feat: add student access code gate for shared courses
d207c793 fix: relax learning mvp schema course references
073c4c0f feat: add learning management mvp
6cdade53 fix: show cloud save only after generation
b952e9a4 fix: hide authoring controls in shared courses
b52a14bd fix: share cloud courses and preserve title
f6d322d1 docs: outline learning account sharing roadmap
042fe70b fix: reduce scene content payload size
95f64e59 Update route.ts
fddd70f3 Update route.ts
3816fd77 Update route.ts
d3a74cc3 Update route.ts
a724c5e6 Update route.ts
885dab00 Update route.ts
c76ea3db Update page.tsx
61f634dc Update image-storage.ts
24f0ff92 Update cloud-sync.ts
ca0928c2 Update middleware.ts
3e834068 fix: disable frozen-lockfile via .npmrc
3e88acc3 update pnpm-lock.yaml
d23b41a2 Update vercel.json
3499fe04 Update vercel.json
8045290d Update vercel.json
1c4dc651 Update vercel.json
9782c25c Update vercel.json
dc30972b Update page.tsx
bd55a9c5 Update page.tsx
82b18ab2 Update middleware.ts
c4e297f6 Create cloud-courses.tsx
6cbedc20 Create route.ts
adff7ce9 Create route.ts
cb64b5c7 Create cloud-sync.ts
f7ecf542 Create client.ts
563be70a Update package.json
f79f2547 Update middleware.ts
4025a88b Delete public/old.png
c7600953 Add files via upload
28dc21c6 Delete public/logo-horizontal.png
ef8af414 Update layout.tsx
c63dcde3 Update layout.tsx
a03292e5 Rename ruijiedaxue-logo.png to openmaic-mark.png
ec03e466 Rename openmaic-mark.png to old.png
4a2eebd7 Add files via upload
04b70f03 feat(storage): scaffold @openmaic/storage — KV + asset primitives (browser) (#857) (#858)
1f187ed8 chore(renderer): machine-enforce the @openmaic/renderer import boundary (#853)
b53f202d feat(renderer): scaffold @openmaic/renderer/editing subpath (v2 editing surface, Stage 0) (#855)
ee626121 fix(slide): tolerate malformed generated slide data
be57c52d fix(docker): fix postinstall script failure in Docker build (#835)
b669f791 feat(importer): normalize slides at the pipeline output boundary (#787 follow-up) (#845)
6b93980f feat(editor): redesign the narration timeline (action picker + inline insert) and enable it for interactive/PBL scenes (#834)
0b1304fe fix(editor): show per-line loading while the batch "regenerate all TTS" runs (#830)
fcdb6d62 feat(dsl): own element-level normalization & defaults; wire the generator (#787) (#832)
4b821272 feat(interactive-actions): feed real HTML element inventory into the prompt (#829)
d54e62f5 feat(token-plan): one-click token-plan setup + deployment usage dashboard (#784)
8a9cf24a Update Doubao Seed model catalog (#827)
3b7a0ca0 feat(document): add multi-format course material upload (#741)
cd5f997d docs: document the dev-server OOM workaround for large generations (#808)
9ffdd72f fix(quiz): render formulas in quiz text (#833)
9b4746ef feat(dsl): activate the migration registry + runner (#787 Part B-2) (#825)
3f851bbc fix(ai): close PROVIDERS/THINKING_CAPABILITIES metadata drift with a guard (#809)
6d1fd2ba fix(export): compute SVG path bounding box via getBounds() (#656)
6fb87e7d fix(tts): respect string context when splitting the Doubao stream (#677)
eca6811c fix(export): keep sibling attributes when style is empty (#683)
74ff4ada fix(web-search): match Brave's current result-title markup (#688)
b6fe2814 fix(quiz): stop leaking questions on entry and pass results to chat agent (#823)
6538e718 feat(editor): in-editor authoring of classroom agents (Stage-level roster) (#816)
7c19ab8f feat(dsl): JSON Schema artifacts + pure validators (#787 Part B-1) (#817)
5daf3e5a fix(editor): keep emptied/zero-action scenes playable, bind outline by stable id, surface incomplete content (#814)
b516427d perf(generation): index assigned images by id in fixElementDefaults (#701)
19ff0cef fix(export): convert PPTX shadow offset from px to pt (#679)
a3f88d53 fix(mathml2omml): call includes() instead of indexing it (#681)
b122ca30 feat(dsl): bring the Action playback verbs into @openmaic/dsl (#787)
261fddb0 fix(packages): add openmaic repository metadata (#813)
0bcab10b fix(lecture-notes): render interactive-webpage widget actions in notes area (#810)
72e3ef04 chore(packages): set openmaic package versions to 0.0.2 (#812)
b93434ae feat(agent-edit): multi-session conversation history for the AI editor (#801)
