/**
 * Doc page metadata + lookup. The user-guide lives as plain Markdown in
 * docs/user-guide/, one file per chapter. This module enumerates the
 * chapters and exposes a loader for a single chapter's raw Markdown.
 *
 * Adding a new chapter:
 *   1. Drop `NN-slug.md` into `docs/user-guide/`.
 *   2. Append a `DocChapter` entry to CHAPTERS below (keep ordering by
 *      `order`, the lower-the-sooner the sidebar position).
 *
 * Removing a chapter: delete the file and its entry below. The docs
 * site rebuilds on next request — there is no build-time enumeration.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface DocChapter {
  /** URL slug, e.g. 'getting-started'. */
  readonly slug: string;
  /** Numeric order used for sidebar sorting and breadcrumbs. */
  readonly order: number;
  /** Display title shown in the sidebar and page H1. */
  readonly title: string;
  /** One-sentence summary used in the docs index and meta tags. */
  readonly summary: string;
  /** Filename under docs/user-guide/ (without path). */
  readonly filename: string;
}

export const CHAPTERS: readonly DocChapter[] = [
  {
    slug: 'getting-started',
    order: 1,
    title: '入门 5 分钟',
    summary: '登录、主界面识别、主题/语言切换、退出账号。',
    filename: '01-getting-started.md',
  },
  {
    slug: 'create-course',
    order: 2,
    title: '创建新课件',
    summary: '上传材料、配置 AI 角色与音色、等待生成、失败重试。',
    filename: '02-create-course.md',
  },
  {
    slug: 'edit-course',
    order: 3,
    title: '编辑课件（Pro 模式）',
    summary: '单页文字编辑、章节顺序调整、音色替换、配音重生成。',
    filename: '03-edit-course.md',
  },
  {
    slug: 'share-course',
    order: 4,
    title: '分享课件给学员',
    summary: '学习管理面板、链接分享、批量导入、进度跟踪。',
    filename: '04-share-course.md',
  },
  {
    slug: 'classroom-playback',
    order: 5,
    title: '上课播放',
    summary: '课堂页布局、播放控制、讲解笔记、讨论与 Q&A、语音输入。',
    filename: '05-classroom-playback.md',
  },
  {
    slug: 'course-management',
    order: 6,
    title: '课程管理',
    summary: '我的创作、资源库、搜索、重命名、删除、最近浏览。',
    filename: '06-course-management.md',
  },
  {
    slug: 'settings',
    order: 7,
    title: '设置',
    summary: '通用、TTS / ASR / 图像 / 视频 / PDF / 搜索 / 模型 Provider、用量统计。',
    filename: '07-settings.md',
  },
  {
    slug: 'rj-specific',
    order: 8,
    title: 'RJ 锐捷专属功能',
    summary: '服务端统一配置、教师音色持久化、6 位访问码等 RJ-la 特有功能。',
    filename: '08-rj-specific.md',
  },
  {
    slug: 'faq',
    order: 9,
    title: '常见问题（FAQ）',
    summary: '跨章节的常见问题汇总，按场景分类。',
    filename: '09-faq.md',
  },
];

const DOCS_ROOT = join(process.cwd(), 'docs', 'user-guide');

export function getChapterBySlug(slug: string): DocChapter | undefined {
  return CHAPTERS.find((chapter) => chapter.slug === slug);
}

export function getChapterSource(slug: string): string | null {
  const chapter = getChapterBySlug(slug);
  if (!chapter) return null;
  const filePath = join(DOCS_ROOT, chapter.filename);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf8');
}

export function getAdjacentChapters(slug: string): {
  readonly prev: DocChapter | null;
  readonly next: DocChapter | null;
} {
  const index = CHAPTERS.findIndex((c) => c.slug === slug);
  if (index === -1) return { prev: null, next: null };
  return {
    prev: index > 0 ? CHAPTERS[index - 1] : null,
    next: index < CHAPTERS.length - 1 ? CHAPTERS[index + 1] : null,
  };
}