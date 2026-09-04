import { randomUUID } from 'node:crypto';
import { getAuth } from '@/lib/server/auth';
import { readFile } from 'node:fs/promises';
import { PeopleRepository } from '@/lib/server/db/people-repository';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { CourseVideoExportRepository } from '@/lib/server/db/course-video-export-repository';
import { getDatabasePool, closeDatabasePool } from '@/lib/server/db/pool';
import { getVideoExportService } from '@/lib/export/video-export-service';
import { runNextCourseVideoExport } from '@/lib/server/course-video-export-worker';
import { CosStorage } from '@/lib/server/cos-storage';
import { compileCourseVideo } from '@/lib/video-export/compile-course-video';

async function main() {
const marker = `video-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`;
const email = `${marker}@local.test`;
const password = `Smoke-${randomUUID()}!`;
const courseId = marker;
const pool = getDatabasePool();
const people = new PeopleRepository(pool);
const courses = new CourseRepository(pool);
const exports = new CourseVideoExportRepository(pool);
const storage = new CosStorage();
let userId: string | undefined;
let exportId: string | undefined;
let inputKey: string | undefined;
let outputKey: string | undefined;

async function removeSmokeData() {
  if (outputKey) await storage.deleteObject(outputKey).catch(() => undefined);
  if (inputKey) await storage.deleteObject(inputKey).catch(() => undefined);
  if (exportId) await pool.query('DELETE FROM app.course_video_exports WHERE id = $1', [exportId]).catch(() => undefined);
  await pool.query('DELETE FROM app.courses WHERE id = $1', [courseId]).catch(() => undefined);
  if (userId) {
    await pool.query('DELETE FROM app.user_profiles WHERE user_id = $1', [userId]).catch(() => undefined);
    await pool.query('DELETE FROM public.session WHERE user_id = $1', [userId]).catch(() => undefined);
    await pool.query('DELETE FROM public.account WHERE user_id = $1', [userId]).catch(() => undefined);
    await pool.query('DELETE FROM public."user" WHERE id = $1', [userId]).catch(() => undefined);
  }
}

try {
  const created = await getAuth().api.createUser({ body: { email, password, name: 'Video Smoke Teacher' } });
  userId = created.user.id;
  await people.createProfile({ userId, role: 'teacher', displayName: 'Video Smoke Teacher', mustChangePassword: false });
  await courses.createCourse({ id: courseId, ownerUserId: userId, title: 'Video smoke course', topic: 'native validation', content: { scenes: [] }, saveState: 'ready' });

  const service = getVideoExportService();
  const capability = await service.getCapability();
  if (!capability.available) throw new Error(`Native render service unavailable: ${capability.message}`);
  const createdExport = await service.request({ courseId, requestedBy: userId, format: 'mp4' });
  exportId = createdExport.id;
  const rowBeforeUpload = await exports.get(exportId);
  inputKey = (rowBeforeUpload?.request as { uploadObjectKey?: string })?.uploadObjectKey;
  if (!inputKey || await exports.claimNext()) throw new Error('Upload-pending video export was incorrectly claimable');

  const gsap = new Uint8Array(await readFile('public/vendor/gsap.min.js'));
  const zip = await compileCourseVideo({ stageName: 'Native smoke', pages: [{ id: 'cover-1', title: 'Native smoke', kind: 'cover', body: 'PostgreSQL + COS + FFmpeg', narration: [] }] }, async () => undefined, gsap);
  const upload = await fetch(createdExport.inputUploadUrl, { method: 'PUT', headers: { 'content-type': 'application/zip' }, body: new Blob([new Uint8Array(zip)], { type: 'application/zip' }) });
  if (!upload.ok) throw new Error(`COS ZIP upload failed: HTTP ${upload.status}`);
  const activated = await service.confirmInputUpload(exportId);
  if (!activated) throw new Error('Video export activation failed');

  if (!(await runNextCourseVideoExport())) throw new Error('Worker did not claim the activated export');
  const completed = await exports.get(exportId);
  if (completed?.status !== 'succeeded' || !completed.output) throw new Error(`Video export failed: ${completed?.status ?? 'missing'} ${completed?.error ?? ''}`);
  outputKey = completed.output.objectKey;
  const video = await storage.getObject(outputKey);
  if (video.length < 1024 || video.subarray(4, 8).toString('ascii') !== 'ftyp') throw new Error(`Invalid MP4 output (${video.length} bytes)`);
  const downloadUrl = await storage.getDownloadUrl(outputKey);
  const download = await fetch(downloadUrl);
  if (!download.ok || (await download.arrayBuffer()).byteLength !== video.length) throw new Error('COS MP4 download verification failed');
  console.log(JSON.stringify({ success: true, courseId, exportId, mp4Bytes: video.length }));
} finally {
  await removeSmokeData();
  await closeDatabasePool();
}
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
