export const COURSE_ASSET_BUCKET = 'course-assets';
export type CourseAssetKind = 'images' | 'audio' | 'material';

/**
 * 课程材料支持的文件类型(扩展名 + MIME)。
 * 维持现状:.pdf / .docx / .pptx / .txt / .md / .markdown。
 * 与 lib/document/mime.ts 的 COURSE_MATERIAL_ACCEPT 语义对齐,
 * 这里只取子集以保证 bucket 一致放行。
 */
export const MATERIAL_EXTENSIONS = new Set(['pdf', 'docx', 'pptx', 'txt', 'md', 'markdown']);

export const MATERIAL_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
};

/**
 * 首期课程材料上传上限:49 MB，和页面提示保持一致。
 */
export const MATERIAL_MAX_BYTES = 49_000_000;

/** A lesson can be generated from a small, ordered set of source materials. */
export const MAX_COURSE_MATERIAL_FILES = 5;

/** 面向用户的上限文案。 */
export const MATERIAL_MAX_HUMAN = '49MB';
