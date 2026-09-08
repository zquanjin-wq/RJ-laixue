# PPTX AI 课堂 API（v1）

所有请求使用 `Authorization: Bearer laix_…`；令牌需包含 `classroom:write`，查询任务需包含 `classroom:read`。

## 1. 创建上传会话

`POST /api/v1/pptx-sources`

```json
{ "fileName": "培训课件.pptx", "sizeBytes": 1234567 }
```

返回 `assetId`、一次性 `uploadUrl` 和 `confirmUrl`。调用方用 `PUT uploadUrl` 上传原始 PPTX，Content-Type 为 `application/vnd.openxmlformats-officedocument.presentationml.presentation`。

## 2. 确认源文件

`PATCH /api/v1/pptx-sources/{assetId}`

```json
{ "fileName": "培训课件.pptx" }
```

服务端确认 COS 对象已存在后返回 `sourceId`。PPTX 源文件不可变，可作为后续课程生成的审计锚点。

## 3. 创建可编辑草稿

外部 Skill 用 OpenMAIC importer 解析 PPTX 后，调用：

`POST /api/v1/pptx-classrooms/drafts`

```json
{
  "sourceId": "<source UUID>",
  "fileName": "培训课件.pptx",
  "slides": ["<OpenMAIC Slide JSON>"]
}
```

返回 `courseId` 与 `sourceRevision`。`slides` 是 importer 输出的有序 Slide JSON，不需要也不应上传为 base64 PPTX。

## 4. 生成 AI 互动课程

`POST /api/v1/pptx-classrooms`，同时携带不重复的 `Idempotency-Key`：

```json
{
  "sourceId": "<source UUID>",
  "courseId": "<course UUID>",
  "sourceRevision": 1,
  "teachingRequirement": "为新任讲师讲解产品，并安排轻量互动。",
  "interactionIntensity": "standard",
  "enableTTS": true,
  "companionCount": 2,
  "teacherVoice": {
    "providerId": "minimax-tts",
    "voiceId": "male-qingnian"
  }
}
```

返回 `jobId` 和 `pollUrl`。轮询 `GET /api/v1/pptx-classrooms/{jobId}` 至 `status=succeeded`，再打开 `/classroom/{courseId}?editor=1`。

课程生成在服务端串行完成讲稿、AI 教师/伴学、互动动作和逐段配音；启用 TTS 时音频覆盖校验不通过会使任务失败，不会交付静音课程。
