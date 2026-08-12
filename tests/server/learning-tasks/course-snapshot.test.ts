/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Gate 1A: 课程快照服务测试
 */
import { describe, expect, it } from 'vitest';
import {
  buildCourseSnapshot,
  computeCourseDataHash,
  canonicalJson,
  toSafeView,
  type CourseRow,
  type CourseData,
} from '@/lib/server/learning-tasks/course-snapshot';

// --- Helpers ---

function makeCourseRow(overrides: Partial<CourseRow> & { data: CourseData }): CourseRow {
  return {
    id: 'course-1',
    title: '测试课程',
    topic: '测试',
    data: overrides.data,
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function makeData(stage?: Record<string, unknown>, scenes?: Record<string, unknown>[]): CourseData {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stage: (stage ?? { id: 's1', name: 'Stage 1', description: 'desc' }) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scenes: (scenes ?? [
      { id: 'sc1', type: 'slide', title: 'Scene 1', order: 0 },
      { id: 'sc2', type: 'quiz', title: 'Quiz Scene', order: 1 },
    ]) as any,
    outlines: [
      {
        id: 'o1',
        title: 'Chapter 1',
        type: 'slide' as const,
        description: '',
        keyPoints: [],
        order: 0,
      },
    ],
  };
}

describe('computeCourseDataHash', () => {
  it('相同数据产生相同 hash', () => {
    const data = { a: 1, b: 'test' };
    const h1 = computeCourseDataHash(data);
    const h2 = computeCourseDataHash(data);
    expect(h1).toBe(h2);
  });

  it('不同数据产生不同 hash', () => {
    const h1 = computeCourseDataHash({ a: 1 });
    const h2 = computeCourseDataHash({ a: 2 });
    expect(h1).not.toBe(h2);
  });
});

describe('buildCourseSnapshot', () => {
  it('正常课程数据生成完整快照', () => {
    const row = makeCourseRow({ data: makeData() });
    const snapshot = buildCourseSnapshot(row);
    expect(snapshot).not.toBeNull();

    if (!snapshot) return; // type guard

    expect(snapshot.courseId).toBe('course-1');
    expect(snapshot.title).toBe('测试课程');
    expect(snapshot.sourceHash).toBeTruthy();
    expect(snapshot.scenes).toHaveLength(2);
    expect(snapshot.outlines).toHaveLength(1);
    expect(snapshot.stage.id).toBe('s1');
  });

  it('quiz 场景不泄漏答案', () => {
    const row = makeCourseRow({
      data: makeData({ id: 's1' }, [
        { id: 'sc1', type: 'slide', title: 'S1', order: 0 },
        {
          id: 'sc2',
          type: 'quiz',
          title: 'Quiz',
          order: 1,
          content: {
            type: 'quiz',
            questions: [
              {
                id: 'q1',
                type: 'single',
                question: 'What?',
                answer: ['B'],
                options: [
                  { id: 'A', label: 'A' },
                  { id: 'B', label: 'B' },
                ],
              },
            ],
          },
        },
      ]),
    });

    const snapshot = buildCourseSnapshot(row);
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    const safe = toSafeView(snapshot);
    const quizScene = safe.scenes[1];
    expect(quizScene.quizzes).toBeDefined();
    expect(quizScene.quizzes!.count).toBe(1);
    expect(quizScene.quizzes!.types).toEqual(['single']);

    // 内部快照包含答案（用于重放），安全视图不泄漏
    const json = JSON.stringify(safe);
    expect(json).not.toContain('"B"');
    expect(json).not.toContain('What?');
  });

  it('null data 返回 null', () => {
    const row: CourseRow = {
      id: 'c1',
      title: null,
      topic: null,
      data: null,
      created_by: null,
      created_at: null,
      updated_at: null,
    };
    expect(buildCourseSnapshot(row)).toBeNull();
  });

  it('data 中缺少 stage 或 scenes 返回 null', () => {
    const row = makeCourseRow({
      data: { stage: null as unknown as CourseData['stage'], scenes: [] as CourseData['scenes'] },
    });
    expect(buildCourseSnapshot(row)).toBeNull();
  });

  it('相同 data 产生相同 sourceHash', () => {
    const data = makeData();
    const row1 = makeCourseRow({ data });
    const row2 = makeCourseRow({ data: JSON.parse(JSON.stringify(data)) });

    const s1 = buildCourseSnapshot(row1);
    const s2 = buildCourseSnapshot(row2);

    expect(s1?.sourceHash).toBe(s2?.sourceHash);
  });

  it('完整快照保存 stage/scenes/outlines 数据', () => {
    const data = makeData();
    const row = makeCourseRow({ data });
    const snapshot = buildCourseSnapshot(row);
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    expect(snapshot.stage).toBeDefined();
    expect(snapshot.stage.id).toBe('s1');
    expect(snapshot.scenes).toHaveLength(2);
    expect(snapshot.outlines).toHaveLength(1);
  });
});

describe('canonicalJson', () => {
  it('键顺序不同产生相同 JSON', () => {
    const a = { b: 1, a: 2 };
    const b = { a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('computeCourseDataHash 对键顺序无关', () => {
    const d1 = { scenes: [{ id: '1', order: 0 }], stage: { id: 's1' } };
    const d2 = { stage: { id: 's1' }, scenes: [{ id: '1', order: 0 }] };
    const h1 = computeCourseDataHash(d1);
    const h2 = computeCourseDataHash(d2);
    expect(h1).toBe(h2);
  });
});

describe('toSafeView', () => {
  it('移除 warnings 字段', () => {
    const row = makeCourseRow({ data: makeData() });
    const snapshot = buildCourseSnapshot(row)!;

    const safe = toSafeView(snapshot);
    expect(safe).not.toHaveProperty('warnings');
    // 保留所有其他字段
    expect(safe.courseId).toBe(snapshot.courseId);
    expect(safe.sourceHash).toBe(snapshot.sourceHash);
  });
});
