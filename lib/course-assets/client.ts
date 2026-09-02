import { MATERIAL_EXTENSIONS, MATERIAL_MIME_TYPES, type CourseAssetKind } from './shared';
import { createLogger } from '@/lib/logger';

const log = createLogger('CourseAssets');

export { COURSE_ASSET_BUCKET, MATERIAL_MAX_BYTES, type CourseAssetKind } from './shared';

const DATA_URI = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/;

function extensionFor(contentType: string, kind: CourseAssetKind): string {
  const subtype = contentType.split('/')[1]?.toLowerCase().split(';')[0];

  if (kind === 'images') {
    const allowed = new Set(['png', 'jpeg', 'jpg', 'webp', 'gif', 'svg+xml']);
    if (!subtype || !allowed.has(subtype)) return 'png';
    if (subtype === 'jpeg') return 'jpg';
    if (subtype === 'svg+xml') return 'svg';
    return subtype;
  }

  if (kind === 'audio') {
    const allowed = new Set(['mpeg', 'mp3', 'wav', 'ogg', 'webm', 'mp4', 'aac']);
    if (!subtype || !allowed.has(subtype)) return 'mp3';
    if (subtype === 'mpeg') return 'mp3';
    return subtype;
  }

  // material: 从 contentType 反查(优先),否则用 subtype
  for (const [ext, mime] of Object.entries(MATERIAL_MIME_TYPES)) {
    if (mime === contentType) return ext;
  }
  if (subtype && MATERIAL_EXTENSIONS.has(subtype)) return subtype;
  return 'pdf';
}

export function dataUriToBlob(value: string): Blob | null {
  const match = value.match(DATA_URI);
  if (!match) return null;
  const contentType = match[1] || 'application/octet-stream';
  try {
    if (match[2]) {
      const binary = atob(match[3]);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new Blob([bytes], { type: contentType });
    }
    return new Blob([decodeURIComponent(match[3])], { type: contentType });
  } catch {
    throw new Error('资产 data URI 无法解码');
  }
}

export interface SignedUploadRequest {
  courseId: string;
  kind: CourseAssetKind;
  contentType: string;
  size?: number;
}

export interface SignedUploadResponse {
  path: string;
  uploadUrl: string;
  publicUrl: string;
}

/**
 * 申请一个直传 COS 的短期上传地址。
 */
async function requestSignedUpload({
  courseId,
  kind,
  contentType,
  size,
  extension,
}: SignedUploadRequest & { extension: string }): Promise<SignedUploadResponse> {
  const response = await fetch('/api/course-assets/sign-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courseId, kind, contentType, extension, size }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.data?.uploadUrl || !result?.data?.path || !result?.data?.publicUrl) {
    const err = new Error(result?.error || `申请资产上传授权失败(HTTP ${response.status})`);
    (err as Error & { code?: string; status?: number }).code = result?.code;
    (err as Error & { code?: string; status?: number }).status = response.status;
    throw err;
  }
  return result.data as SignedUploadResponse;
}

/**
 * 浏览器通过短期地址直传 Blob 到 COS，文件不经过应用服务器。
 */
export async function uploadCourseBlob(
  courseId: string,
  kind: CourseAssetKind,
  blob: Blob,
): Promise<string> {
  const contentType =
    blob.type ||
    (kind === 'images' ? 'image/png' : kind === 'audio' ? 'audio/mpeg' : 'application/pdf');
  const extension = extensionFor(contentType, kind);

  const signed = await requestSignedUpload({
    courseId,
    kind,
    contentType,
    size: blob.size,
    extension,
  });
  const upload = await fetch(signed.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: blob,
  });
  if (!upload.ok) throw new Error(`资产直传失败(HTTP ${upload.status})`);
  return signed.publicUrl as string;
}

export async function uploadCourseDataUri(
  courseId: string,
  kind: CourseAssetKind,
  value: string,
): Promise<string> {
  const blob = dataUriToBlob(value);
  if (!blob) return value;
  return uploadCourseBlob(courseId, kind, blob);
}

/**
 * 课程材料直传。返回 COS 内的对象路径，
 * 由调用方在后续请求里把这个 path 传给 extract-document / parse-pdf。
 *
 * 与 uploadCourseBlob 的区别:不返回 publicUrl,因为课程材料路径只需服务端解析用,
 * 不在前端展示。
 */
export async function uploadCourseMaterial(
  courseId: string,
  file: File | Blob,
): Promise<{ path: string; size: number }> {
  const contentType = file.type || 'application/pdf';
  const extension = extensionFor(contentType, 'material');
  const signed = await requestSignedUpload({
    courseId,
    kind: 'material',
    contentType,
    size: file.size,
    extension,
  });
  const upload = await fetch(signed.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: file,
  });
  if (!upload.ok) throw new Error(`课程材料直传失败(HTTP ${upload.status})`);
  return { path: signed.path, size: file.size };
}

/**
 * 文本(代码作业)直传为 material 类型 — 文本文件统一当 .txt 处理。
 */
export async function uploadCourseTextMaterial(
  courseId: string,
  text: string,
): Promise<{ path: string; size: number }> {
  const blob = new Blob([text], { type: 'text/plain' });
  const signed = await requestSignedUpload({
    courseId,
    kind: 'material',
    contentType: 'text/plain',
    size: blob.size,
    extension: 'txt',
  });
  const upload = await fetch(signed.uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/plain',
    },
    body: blob,
  });
  if (!upload.ok) throw new Error(`文本作业直传失败(HTTP ${upload.status})`);
  return { path: signed.path, size: blob.size };
}

// ── 并发上传池 ────────────────────────────────────────────────────────────────

export interface ConcurrentUploadTask {
  /** 唯一标识（用于失败汇报） */
  id: string;
  courseId: string;
  kind: CourseAssetKind;
  blob: Blob;
}

export interface ConcurrentUploadResult {
  id: string;
  success: boolean;
  publicUrl?: string;
  error?: string;
}

/**
 * 并发上传多个 blob 到 course-assets bucket。
 *
 * 默认 6 路并发池，每路独立执行 sign-upload → PUT 链路。
 * 单条失败最多重试 2 次，不阻断其他条目的上传。
 *
 * 与 storeImagesFromUrls 的并发池模式同构（worker pool + shared cursor）。
 */
export async function uploadCourseBlobsConcurrently(
  tasks: ConcurrentUploadTask[],
  concurrency: number = 6,
  maxRetries: number = 2,
): Promise<ConcurrentUploadResult[]> {
  const results: ConcurrentUploadResult[] = new Array(tasks.length);
  let cursor = 0;

  async function uploadSingle(task: ConcurrentUploadTask, idx: number): Promise<void> {
    let lastError = '';
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const publicUrl = await uploadCourseBlob(task.courseId, task.kind, task.blob);
        results[idx] = { id: task.id, success: true, publicUrl };
        return;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (attempt < maxRetries) {
          log.warn(`Upload retry ${attempt + 1}/${maxRetries}: ${task.id} (${lastError})`);
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        }
      }
    }
    results[idx] = { id: task.id, success: false, error: lastError };
  }

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= tasks.length) return;
      await uploadSingle(tasks[idx], idx);
    }
  }

  const workerCount = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
