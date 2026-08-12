/**
 * Gate 0.1 课程快照探针单元测试
 * 覆盖 buildCourseSnapshot 纯函数：正常结构、空 scenes、quiz scene、order/seq 降级。
 */

import { describe, it, expect } from 'vitest';
import {
  buildCourseSnapshot,
  computeCourseDataHash,
} from '@/scripts/gate0-audit/inspect-course-snapshot';
import type { CourseRow } from '@/scripts/gate0-audit/inspect-course-snapshot';
import type { Scene, Stage } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

function makeStage(partial: Partial<Stage> = {}): Stage {
  return {
    ...partial,
    id: partial.id ?? 'stage-1',
    name: partial.name ?? '测试课程',
    description: partial.description ?? '测试描述',
    createdAt: partial.createdAt ?? Date.now(),
    updatedAt: partial.updatedAt ?? Date.now(),
  };
}

function makeScene(partial: Partial<Scene> & { id: string }): Scene {
  return {
    ...partial,
    id: partial.id,
    stageId: partial.stageId ?? 'stage-1',
    type: partial.type ?? 'slide',
    title: partial.title ?? '测试场景',
    order: 'order' in partial ? partial.order : 0,
    seq: 'seq' in partial ? partial.seq : 0,
    content:
      partial.content ??
      ({ type: 'slide', canvas: { type: 'slide', elements: [] } } as unknown as Scene['content']),
    createdAt: partial.createdAt ?? Date.now(),
    updatedAt: partial.updatedAt ?? Date.now(),
  } as Scene;
}

function makeOutline(partial: Partial<SceneOutline> & { id: string }): SceneOutline {
  return {
    ...partial,
    id: partial.id,
    type: partial.type ?? 'slide',
    title: partial.title ?? '测试章节',
    description: partial.description ?? '',
    keyPoints: partial.keyPoints ?? [],
    order: partial.order ?? 0,
  } as SceneOutline;
}

function makeCourseRow(partial: Partial<CourseRow> = {}): CourseRow {
  return {
    id: 'course-1',
    title: '测试课程标题',
    topic: '测试主题',
    data: {
      stage: makeStage(),
      scenes: [],
      outlines: [],
    },
    created_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...partial,
  };
}

describe('buildCourseSnapshot', () => {
  it('从 { stage, scenes, outlines } 提取课程快照', () => {
    const course = makeCourseRow({
      data: {
        stage: makeStage({ id: 'stage-1', name: '课程 A', description: '描述 A' }),
        scenes: [
          makeScene({ id: 'scene-1', type: 'slide', title: '第一页', order: 0, seq: 0 }),
          makeScene({ id: 'scene-2', type: 'slide', title: '第二页', order: 1, seq: 1 }),
        ],
        outlines: [makeOutline({ id: 'outline-1', title: '章节一', order: 0 })],
      },
    });

    const snapshot = buildCourseSnapshot(course);

    expect(snapshot.courseId).toBe('course-1');
    expect(snapshot.stage.id).toBe('stage-1');
    expect(snapshot.stage.name).toBe('课程 A');
    expect(snapshot.scenes).toHaveLength(2);
    expect(snapshot.scenes[0].id).toBe('scene-1');
    expect(snapshot.scenes[0].order).toBe(0);
    expect(snapshot.scenes[1].order).toBe(1);
    expect(snapshot.outlines).toHaveLength(1);
    expect(snapshot.outlines[0].id).toBe('outline-1');
    expect(snapshot.warnings).toHaveLength(0);
  });

  it('scene.outlineId 正确关联到 outline', () => {
    const course = makeCourseRow({
      data: {
        stage: makeStage(),
        scenes: [
          makeScene({
            id: 'scene-1',
            type: 'slide',
            title: '第一页',
            order: 0,
            outlineId: 'outline-1',
          }),
        ],
        outlines: [makeOutline({ id: 'outline-1', title: '真实章节' })],
      },
    });

    const snapshot = buildCourseSnapshot(course);

    expect(snapshot.scenes[0].chapter.id).toBe('outline-1');
    expect(snapshot.scenes[0].chapter.title).toBe('真实章节');
  });

  it('无 outlineId 时以 scene 自身作为章节节点', () => {
    const course = makeCourseRow({
      data: {
        stage: makeStage(),
        scenes: [makeScene({ id: 'scene-1', type: 'slide', title: '独立场景' })],
        outlines: [],
      },
    });

    const snapshot = buildCourseSnapshot(course);

    expect(snapshot.scenes[0].chapter.id).toBe('scene-1');
    expect(snapshot.scenes[0].chapter.title).toBe('独立场景');
  });

  it('空 scenes 时返回空场景数组', () => {
    const course = makeCourseRow({
      data: {
        stage: makeStage(),
        scenes: [],
        outlines: [],
      },
    });

    const snapshot = buildCourseSnapshot(course);

    expect(snapshot.scenes).toEqual([]);
    expect(snapshot.warnings).toHaveLength(0);
  });

  it('quiz scene 提取题目信息但不泄漏标准答案', () => {
    const quizScene = makeScene({
      id: 'scene-quiz',
      type: 'quiz',
      title: '检查题场景',
      order: 2,
      content: {
        type: 'quiz',
        questions: [
          {
            id: 'q-1',
            type: 'single',
            question: '问题 1',
            answer: ['A'],
            hasAnswer: true,
            points: 2,
          },
          {
            id: 'q-2',
            type: 'short_answer',
            question: '问题 2',
            points: 5,
          },
        ],
      },
    });

    const course = makeCourseRow({
      data: {
        stage: makeStage(),
        scenes: [quizScene],
        outlines: [],
      },
    });

    const snapshot = buildCourseSnapshot(course);

    expect(snapshot.scenes).toHaveLength(1);
    expect(snapshot.scenes[0].type).toBe('quiz');
    expect(snapshot.scenes[0].quizzes).toHaveLength(2);
    expect(snapshot.scenes[0].quizzes[0].id).toBe('q-1');
    expect(snapshot.scenes[0].quizzes[0].hasAnswer).toBe(true);
    expect(snapshot.scenes[0].quizzes[0].points).toBe(2);
    expect(snapshot.scenes[0].quizzes[1].hasAnswer).toBe(false);
    // 验证不泄漏标准答案
    expect(snapshot.scenes[0].quizzes[0]).not.toHaveProperty('answer');
    expect(snapshot.scenes[0].quizzes[1]).not.toHaveProperty('answer');
  });

  it('order 缺失时按 seq 降级', () => {
    const course = makeCourseRow({
      data: {
        stage: makeStage(),
        scenes: [
          makeScene({ id: 'scene-1', type: 'slide', title: '第一页', order: undefined, seq: 3 }),
        ],
        outlines: [],
      },
    });

    const snapshot = buildCourseSnapshot(course);

    expect(snapshot.scenes[0].order).toBe(3);
  });

  it('order 和 seq 都缺失时按数组索引降级', () => {
    const course = makeCourseRow({
      data: {
        stage: makeStage(),
        scenes: [
          makeScene({
            id: 'scene-1',
            type: 'slide',
            title: '第一页',
            order: undefined,
            seq: undefined,
          }),
          makeScene({
            id: 'scene-2',
            type: 'slide',
            title: '第二页',
            order: undefined,
            seq: undefined,
          }),
        ],
        outlines: [],
      },
    });

    const snapshot = buildCourseSnapshot(course);

    expect(snapshot.scenes[0].order).toBe(0);
    expect(snapshot.scenes[1].order).toBe(1);
    expect(snapshot.warnings).toContain('scene scene-1 missing order/seq');
    expect(snapshot.warnings).toContain('scene scene-2 missing order/seq');
  });

  it('interactive/pbl 场景标记为 mobile 不支持', () => {
    const course = makeCourseRow({
      data: {
        stage: makeStage(),
        scenes: [
          makeScene({ id: 'scene-slide', type: 'slide', title: '普通页' }),
          makeScene({ id: 'scene-quiz', type: 'quiz', title: '检查题' }),
          makeScene({ id: 'scene-pbl', type: 'pbl', title: 'PBL' }),
        ],
        outlines: [],
      },
    });

    const snapshot = buildCourseSnapshot(course);

    expect(snapshot.scenes[0].mobileSupported).toBe(true);
    expect(snapshot.scenes[1].mobileSupported).toBe(false);
    expect(snapshot.scenes[2].mobileSupported).toBe(false);
  });

  it('course.data 为空时生成警告', () => {
    const course = makeCourseRow({ data: null });

    const snapshot = buildCourseSnapshot(course);

    expect(snapshot.warnings).toContain('course.data is null');
    expect(snapshot.scenes).toEqual([]);
    expect(snapshot.outlines).toEqual([]);
  });
});

describe('computeCourseDataHash', () => {
  it('相同数据产生相同 hash', () => {
    const data = { stage: { id: 's1' }, scenes: [], outlines: [] };
    expect(computeCourseDataHash(data)).toBe(computeCourseDataHash(data));
  });

  it('不同数据产生不同 hash', () => {
    const a = { stage: { id: 's1' }, scenes: [], outlines: [] };
    const b = { stage: { id: 's2' }, scenes: [], outlines: [] };
    expect(computeCourseDataHash(a)).not.toBe(computeCourseDataHash(b));
  });
});
