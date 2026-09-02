/**
 * 课程快照领域服务（Gate 1A.1 修订版）
 *
 * - 内部保存完整 stage/scenes/outlines 供任务重放
 * - 对外生成安全视图，移除标准答案
 * - 使用规范化 JSON hash，键顺序无关
 */
import { createHash } from 'crypto';
import type { Stage } from '@/lib/types/stage';

// ============================================================
// 类型
// ============================================================

export interface CourseData {
  stage: Stage;
  scenes: unknown[];
  outlines?: unknown[];
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

/** 完整课程快照（内部存储，含全部数据供任务重放） */
export interface FullCourseSnapshot {
  courseId: string;
  title: string | null;
  topic: string | null;
  generatedAt: string;
  sourceHash: string;
  stage: Record<string, unknown>;
  scenes: Record<string, unknown>[];
  outlines: Record<string, unknown>[];
}

/** 安全视图中的场景摘要 */
export interface SafeSnapshotScene {
  id: string;
  type: string;
  title: string;
  order: number | null;
  seq: number | null;
  outlineId?: string;
  quizzes?: { count: number; types: string[] };
}

/** 对外安全视图 */
export interface SafeCourseSnapshot {
  courseId: string;
  title: string | null;
  topic: string | null;
  generatedAt: string;
  sourceHash: string;
  stage: { id: string; name: string; description?: string };
  scenes: SafeSnapshotScene[];
  outlines: { id: string; title: string; order: number | null }[];
}

// ============================================================
// 规范化 Hash（键顺序无关）
// ============================================================

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return (value as unknown[]).map(sortKeys);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function computeCourseDataHash(data: unknown): string {
  const canonical = canonicalJson(data);
  return createHash('sha256').update(canonical).digest('hex');
}

// ============================================================
// 快照构建
// ============================================================

export function buildCourseSnapshot(row: CourseRow): FullCourseSnapshot | null {
  if (!row.data) return null;
  const data = row.data as unknown as { stage?: unknown; scenes?: unknown; outlines?: unknown };
  if (!data.stage || !Array.isArray(data.scenes)) return null;

  const sourceHash = computeCourseDataHash(row.data);

  return {
    courseId: row.id,
    title: row.title ?? null,
    topic: row.topic ?? null,
    generatedAt: new Date().toISOString(),
    sourceHash,
    stage: data.stage as Record<string, unknown>,
    scenes: data.scenes as Record<string, unknown>[],
    outlines: (data.outlines as Record<string, unknown>[]) ?? [],
  };
}

export function toSafeView(snapshot: FullCourseSnapshot): SafeCourseSnapshot {
  const safeScenes: SafeSnapshotScene[] = snapshot.scenes.map((s) => {
    const scene: SafeSnapshotScene = {
      id: (s.id as string) ?? '',
      type: (s.type as string) ?? 'unknown',
      title: (s.title as string) ?? '',
      order: typeof s.order === 'number' ? (s.order as number) : null,
      seq: typeof s.seq === 'number' ? (s.seq as number) : null,
      outlineId: s.outlineId as string | undefined,
    };

    if (s.type === 'quiz' && s.content) {
      const content = s.content as Record<string, unknown>;
      if (Array.isArray(content.questions)) {
        const qs = content.questions as Array<Record<string, unknown>>;
        scene.quizzes = {
          count: qs.length,
          types: [...new Set(qs.map((q) => (typeof q.type === 'string' ? q.type : 'unknown')))],
        };
      }
    }

    return scene;
  });

  return {
    courseId: snapshot.courseId,
    title: snapshot.title,
    topic: snapshot.topic,
    generatedAt: snapshot.generatedAt,
    sourceHash: snapshot.sourceHash,
    stage: {
      id: (snapshot.stage.id as string) ?? '',
      name: (snapshot.stage.name as string) ?? '',
      description: snapshot.stage.description as string | undefined,
    },
    scenes: safeScenes,
    outlines: snapshot.outlines.map((o) => ({
      id: (o.id as string) ?? '',
      title: (o.title as string) ?? '',
      order: o.order != null ? (o.order as number) : null,
    })),
  };
}
