New-Item -ItemType Directory -Force .\\docs | Out-Null



@'

\# 本地语音音频云端发布能力改造记录



\## 一、背景问题



项目中教师端可以在课程中生成语音内容，语音音频原本存储在浏览器本地 IndexedDB 中。



这导致一个问题：



\- 教师端本地可以播放语音；

\- 课程保存到云端后，课程 JSON 中只有本地音频标识；

\- 学生端、无痕窗口、其他浏览器无法访问教师浏览器中的 IndexedDB；

\- 因此学生端播放课程语音时会失败。



核心原因是：



```text

音频文件只存在教师本地浏览器，没有发布到云端可访问地址。

```



\---



\## 二、目标



本次改造目标：



1\. 教师点击保存课程到云端时，自动扫描课程中的语音动作；

2\. 找到仍然只存在本地的语音音频；

3\. 从 IndexedDB 中读取本地音频 Blob；

4\. 上传音频到 Supabase Storage；

5\. 获取云端公开访问地址；

6\. 将地址写入课程数据中的 `audioUrl`；

7\. 再将完整课程数据保存到 Supabase `courses` 表；

8\. 学生端、无痕窗口、其他浏览器可以直接播放云端音频。



\---



\## 三、主要改动文件



本次核心改动涉及 3 个文件：



```text

lib/audio/audio-publish.ts

app/api/audio-upload/route.ts

lib/utils/cloud-sync.ts

```



\---



\## 四、新增文件：lib/audio/audio-publish.ts



新增 `lib/audio/audio-publish.ts`，负责课程保存前的本地音频发布逻辑。



主要职责：



1\. 扫描课程 `scenes`；

2\. 找到 `speech` 类动作；

3\. 判断动作中是否已有 `audioUrl`；

4\. 如果没有 `audioUrl`，则根据 `audioId` 从本地 IndexedDB 读取音频；

5\. 调用 `/api/audio-upload` 上传音频；

6\. 将返回的云端 URL 写回对应 action；

7\. 汇总上传结果，包括：

&#x20;  - `uploaded`

&#x20;  - `skipped`

&#x20;  - `missing`

&#x20;  - `failed`

8\. 返回更新后的 scenes。



设计原则：



\- 已经有 `audioUrl` 的语音不重复上传；

\- 本地音频缺失时记录为 `missing`；

\- 上传失败时记录为 `failed`；

\- 如果有失败或缺失，阻止课程保存，避免发布损坏课程；

\- 文件名、路径做了清洗，避免 Supabase Storage 路径异常。



\---



\## 五、修改文件：app/api/audio-upload/route.ts



修改 `/api/audio-upload` 接口，使其支持接收前端传来的音频文件并上传至 Supabase Storage。



主要逻辑：



1\. 接收 `FormData`：

&#x20;  - `file`

&#x20;  - `stageId`

&#x20;  - `audioId`

2\. 校验参数；

3\. 使用 Supabase Service Role Key 创建服务端客户端；

4\. 将音频上传到 bucket：



```text

course-audio

```



5\. 上传路径格式：



```text

classrooms/{stageId}/audio/{audioId}.{ext}

```



6\. 使用 `upsert: true`，支持重复保存时覆盖同名音频；

7\. 返回可访问的 `publicUrl`。



注意事项：



\- Supabase 中需要存在 bucket：



```text

course-audio

```



\- 如果学生端要直接播放公开 URL，建议该 bucket 设置为 Public。



\---



\## 六、修改文件：lib/utils/cloud-sync.ts



在 `saveStageToCloud(stageId)` 中集成音频发布逻辑。



改造前流程：



```text

读取本地课程数据

&#x20; ↓

直接 POST /api/courses 保存到云端

```



改造后流程：



```text

读取本地课程数据

&#x20; ↓

publishSceneAudioAssets(stageId, scenes)

&#x20; ↓

上传本地音频到 Supabase Storage

&#x20; ↓

将 audioUrl 写回 scenes

&#x20; ↓

如果存在上传失败或本地音频缺失，则阻止保存

&#x20; ↓

POST /api/courses 保存完整课程数据

&#x20; ↓

保存成功后，将补齐 audioUrl 的 scenes 回写本地 IndexedDB

```



关键收益：



\- 课程保存到云端的数据中已经包含 `audioUrl`；

\- 学生端不再依赖教师本地 IndexedDB；

\- 保存成功后本地 scenes 也会被更新，避免下次重复上传。



\---



\## 七、中途问题及修复



\### 1. cloud-sync.ts 出现编码损坏



执行 lint 时出现：



```text

Parsing error: Unterminated string literal

```



定位到 `lib/utils/cloud-sync.ts` 中有乱码字符串导致 TypeScript 语法损坏。



修复内容包括：



```ts

title: stageName || '未命名课程',

```



以及：



```ts

if (!data) throw new Error('课程不存在');

```



修复后 `cloud-sync.ts` 的 Parsing error 消失。



\---



\## 八、Lint 检查结果



执行：



```powershell

npm run lint

```



结果中，本次修改导致的 `cloud-sync.ts Parsing error` 已解决。



剩余 lint 问题为项目既有问题，主要包括：



\- `Unexpected any`

\- `prefer-const`

\- React Hook dependency warning

\- unused vars warning



这些不影响本次音频云端发布能力。



\---



\## 九、真实环境验证记录



\### 1. 启动项目



执行：



```powershell

npm run dev

```



访问：



```text

http://localhost:3000

```



\### 2. 保存课程时的服务端日志



点击保存课程后，终端出现多次：



```text

POST /api/audio-upload 200

```



最后出现：



```text

POST /api/courses 200

```



说明：



\- 本地音频上传接口调用成功；

\- 课程最终保存到云端成功。



\---



\## 十、Supabase 数据库验证



在 Supabase SQL Editor 中执行：



```sql

select

&#x20; id,

&#x20; title,

&#x20; jsonb\_path\_query\_array(data, '$.scenes\[\*].actions\[\*].audioUrl') as audio\_urls,

&#x20; updated\_at

from courses

where id = '3Zv\_\_hUcHa';

```



查询结果能看到 `audio\_urls` 中有 Supabase Storage 公网地址。



继续执行数量检查：



```sql

select

&#x20; id,

&#x20; title,

&#x20; jsonb\_array\_length(

&#x20;   jsonb\_path\_query\_array(data, '$.scenes\[\*].actions\[\*].audioUrl')

&#x20; ) as audio\_url\_count,

&#x20; updated\_at

from courses

where id = '3Zv\_\_hUcHa';

```



验证结果：



```text

audio\_url\_count = 35

```



说明课程中共有 35 条语音动作成功写入云端 `audioUrl`。



测试课程：



```text

id: 3Zv\_\_hUcHa

title: 台风眼壁置换

```



\---



\## 十一、学生端播放验证



使用无痕窗口访问：



```text

http://localhost:3000/classroom/3Zv\_\_hUcHa

```



验证结果：



```text

可以正常播放语音

```



这说明：



\- 学生端没有依赖教师本地 IndexedDB；

\- 播放使用的是云端 `audioUrl`；

\- 本次修复闭环成功。



\---



\## 十二、当前 Git 提交记录



本次核心功能已经提交：



```text

branch: fix-publish-local-audio-url

commit: 4fffd08

message: feat: publish local speech audio assets when saving course to cloud

```



提交内容：



```text

3 files changed, 320 insertions(+), 38 deletions(-)

create mode 100644 lib/audio/audio-publish.ts

```



涉及文件：



```text

app/api/audio-upload/route.ts

lib/utils/cloud-sync.ts

lib/audio/audio-publish.ts

```



\---



\## 十三、后续建议优化



当前功能已经可用，后续可考虑优化：



\### 1. 保存课程时显示上传进度



例如：



```text

正在上传语音 12 / 35

正在保存课程...

保存成功

```



\### 2. 音频上传改为并发



当前日志显示音频是逐条上传，稳定但较慢。后续可以改为：



```text

每次并发上传 3～5 条

```



\### 3. 更友好的失败提示



例如：



```text

有 2 条语音上传失败，请重新生成后再保存。

```



\### 4. 重新生成语音后的替换策略



可以进一步明确：



\- 是否沿用原 `audioId` 并覆盖上传；

\- 或生成新 `audioId` 并重新发布。



\### 5. Storage 权限检查



确认 Supabase Storage bucket：



```text

course-audio

```



保持 Public，保证学生端可以直接播放。



\---



\## 十四、最终结论



本次改造已经完成并经过真实环境验证。



最终链路如下：



```text

教师端本地生成语音

&#x20; ↓

点击保存课程到云端

&#x20; ↓

自动上传本地音频到 Supabase Storage

&#x20; ↓

返回云端 audioUrl

&#x20; ↓

写入 courses.data.scenes.actions

&#x20; ↓

保存课程到 Supabase courses 表

&#x20; ↓

学生端、无痕窗口、其他浏览器可直接播放语音

```



结论：



```text

本地语音音频无法在学生端播放的问题已解决。

```

'@ | Set-Content .\\docs\\audio-cloud-publish-log.md -Encoding UTF8



