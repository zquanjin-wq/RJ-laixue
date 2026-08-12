#!/usr/bin/env tsx
/**
 * Gate 0 课程快照只读探针
 * 用途：读取 public.courses.data（真实结构 { stage, scenes, outlines }），
 *       输出标准化课程快照，验证可提取字段。
 * 运行方式：
 *   npx tsx scripts/gate0-audit/inspect-course-snapshot.ts --courseId <course-id>
 * 环境变量：
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 * 注意：本脚本只读，不写入任何数据；快照验证输出不泄漏检查题标准答案。
 */

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import path from 'path';
import type { Scene, Stage } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

interface CourseData {
  stage: Stage;
  scenes: Scene[];
  outlines?: SceneOutline[];
}

export interface CourseRow {
  id: string;
  title: string | null;
  topic: string | null;
  data: CourseData | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface SnapshotQuiz {
  id: string;
  type: string;
  hasAnswer: boolean;
  points?: number;
}

export interface SnapshotScene {
  id: string;
  type: string;
  title: string;
  order: number;
  chapter: { id: string; title: string };
  quizzes: SnapshotQuiz[];
  mobileSupported: boolean;
}

export interface SnapshotOutline {
  id: string;
  title: string;
  order: number;
}

export interface CourseSnapshot {
  courseId: string;
  title: string | null;
  topic: string | null;
  generatedAt: string;
  sourceHash: string;
  stage: { id: string; name: string; description?: string };
  scenes: SnapshotScene[];
  outlines: SnapshotOutline[];
  warnings: string[];
}

const INTERACTIVE_SCENE_TYPES = new Set(['quiz', 'interactive', 'pbl']);

function parseArgs(): { courseId?: string } {
  const args = process.argv.slice(2);
  const result: { courseId?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--courseId' && args[i + 1]) {
      result.courseId = args[i + 1];
      i++;
    }
  }
  return result;
}

function getEnv(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return { url, key };
}

export function computeCourseDataHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isQuizScene(scene: Scene): scene is Scene & {
  content: {
    type: 'quiz';
    questions: Array<{
      id: string;
      type: string;
      answer?: string[];
      hasAnswer?: boolean;
      points?: number;
    }>;
  };
} {
  return (
    scene.type === 'quiz' &&
    typeof scene.content === 'object' &&
    scene.content !== null &&
    (scene.content as { type?: string }).type === 'quiz'
  );
}

function inferChapter(
  scene: Scene,
  outlines: SceneOutline[] | undefined,
  index: number,
): { id: string; title: string } {
  // 真实关联方向：scene.outlineId -> outline.id
  // 没有 outlineId 时，用 scene 自身作为章节节点，不自造 sceneIds。
  if (scene.outlineId && outlines && Array.isArray(outlines)) {
    const matched = outlines.find((o) => o.id === scene.outlineId);
    if (matched) {
      return {
        id: matched.id,
        title: matched.title || `章节 ${index + 1}`,
      };
    }
  }
  return {
    id: scene.id,
    title: scene.title || `场景 ${index + 1}`,
  };
}

export function buildCourseSnapshot(course: CourseRow): CourseSnapshot {
  const data = course.data;
  const warnings: string[] = [];

  if (!data) {
    warnings.push('course.data is null');
  }

  const stage = data?.stage;
  const rawScenes = data?.scenes ?? [];
  const rawOutlines = data?.outlines ?? [];

  const scenes: SnapshotScene[] = [];
  for (let i = 0; i < rawScenes.length; i++) {
    const scene = rawScenes[i];
    const chapter = inferChapter(scene, rawOutlines, i);

    const quizzes: SnapshotQuiz[] = [];
    if (isQuizScene(scene) && Array.isArray(scene.content.questions)) {
      for (const q of scene.content.questions) {
        const hasAnswer = q.hasAnswer ?? (Array.isArray(q.answer) && q.answer.length > 0);
        quizzes.push({
          id: q.id,
          type: q.type,
          hasAnswer,
          points: q.points,
        });
      }
    }

    if (!scene.title) {
      warnings.push(`scene ${scene.id} missing title`);
    }
    if (typeof scene.order !== 'number' && typeof scene.seq !== 'number') {
      warnings.push(`scene ${scene.id} missing order/seq`);
    }

    scenes.push({
      id: scene.id,
      type: scene.type || 'unknown',
      title: scene.title || `场景 ${i + 1}`,
      order: typeof scene.order === 'number' ? scene.order : (scene.seq ?? i),
      chapter,
      quizzes,
      mobileSupported: !INTERACTIVE_SCENE_TYPES.has(scene.type),
    });
  }

  const outlines: SnapshotOutline[] = rawOutlines.map((o, i) => ({
    id: o.id,
    title: o.title || `章节 ${i + 1}`,
    order: typeof o.order === 'number' ? o.order : i,
  }));

  return {
    courseId: course.id,
    title: course.title,
    topic: course.topic,
    generatedAt: new Date().toISOString(),
    sourceHash: computeCourseDataHash(data),
    stage: {
      id: stage?.id || course.id,
      name: stage?.name || course.title || '未命名课程',
      description: stage?.description,
    },
    scenes,
    outlines,
    warnings,
  };
}

async function main() {
  const { courseId } = parseArgs();
  if (!courseId) {
    console.error(
      'Usage: npx tsx scripts/gate0-audit/inspect-course-snapshot.ts --courseId <course-id>',
    );
    process.exit(1);
  }

  const { url, key } = getEnv();
  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase
    .from('courses')
    .select('id, title, topic, data, created_by, created_at, updated_at')
    .eq('id', courseId)
    .single();

  if (error) {
    console.error('Failed to fetch course:', error.message);
    process.exit(1);
  }

  const course = data as CourseRow;
  const snapshot = buildCourseSnapshot(course);

  console.log(JSON.stringify(snapshot, null, 2));
}

// 仅在直接运行时执行 main()，避免被测试导入时触发 process.exit。
// Windows 下 import.meta.url 形如 file:///D:/...，而 process.argv[1] 是 D:\...，
// 需要解码 URL 编码并去掉 pathname 前导斜杠后再比较。
function isMainModule(): boolean {
  const rawPathname = new URL(import.meta.url).pathname;
  const importPath = path.normalize(decodeURIComponent(rawPathname).replace(/^[/\\]/, ''));
  const argvPath = path.normalize(process.argv[1] || '');
  return importPath === argvPath;
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
