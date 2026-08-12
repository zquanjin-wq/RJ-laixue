/** Loads an immutable task-course snapshot after checking task entry permission. */
import { getServiceSupabase } from '@/lib/supabase/server';
import { checkTaskEntryPermission } from './permissions';

export type SnapshotLoadResult =
  | {
      ok: true;
      data: { stage: unknown; scenes: unknown[]; outlines: unknown[] };
      actor: 'learner' | 'preview';
    }
  | { ok: false; error: string; errorCode: string; status: number };

export async function loadTaskSnapshot(
  userId: string,
  taskId: string,
  courseId?: string,
): Promise<SnapshotLoadResult> {
  const svc = getServiceSupabase();
  const { data: task, error: taskError } = await svc
    .from('learning_tasks')
    .select('id, course_id, status, start_at, due_at, snapshot_id')
    .eq('id', taskId)
    .maybeSingle();

  if (taskError)
    return { ok: false, error: '查询任务失败。', errorCode: 'INTERNAL_ERROR', status: 500 };
  if (!task) return { ok: false, error: '任务不存在。', errorCode: 'TASK_NOT_FOUND', status: 404 };
  if (task.status === 'archived' || task.status === 'closed') {
    return { ok: false, error: '任务已结束。', errorCode: 'TASK_CLOSED', status: 403 };
  }
  if (task.status !== 'published') {
    return {
      ok: false,
      error: '任务尚未发布。',
      errorCode: 'TASK_NOT_PUBLISHED',
      status: 403,
    };
  }

  const permission = await checkTaskEntryPermission(userId, taskId);
  if (!permission.ok) {
    const errorCode =
      permission.reason === 'learner_not_bound'
        ? 'LEARNER_NOT_BOUND'
        : permission.reason === 'learner_disabled'
          ? 'LEARNER_DISABLED'
          : 'LEARNER_NOT_ASSIGNED';
    return { ok: false, error: '无权进入此学习任务。', errorCode, status: 403 };
  }
  const entryActor = permission.actor;

  if (entryActor === 'learner' && task.start_at && new Date(task.start_at) > new Date()) {
    return {
      ok: false,
      error: '任务尚未开始。',
      errorCode: 'TASK_NOT_STARTED',
      status: 403,
    };
  }

  let snapshotId = task.snapshot_id;
  if (courseId) {
    const { data: taskCourse } = await svc
      .from('task_courses')
      .select('snapshot_id')
      .eq('task_id', taskId)
      .eq('course_id', courseId)
      .maybeSingle();
    snapshotId = taskCourse?.snapshot_id ?? null;
  }
  if (!snapshotId) {
    return {
      ok: false,
      error: '任务课程快照缺失。',
      errorCode: 'SNAPSHOT_MISSING',
      status: 500,
    };
  }

  const { data: snapshot, error: snapshotError } = await svc
    .from('course_snapshots')
    .select('snapshot_data')
    .eq('id', snapshotId)
    .maybeSingle();
  if (snapshotError || !snapshot) {
    return {
      ok: false,
      error: '课程快照不存在。',
      errorCode: 'SNAPSHOT_NOT_FOUND',
      status: 404,
    };
  }

  const data = (snapshot.snapshot_data ?? {}) as {
    stage?: unknown;
    scenes?: unknown;
    outlines?: unknown;
  };
  if (!data.stage || !Array.isArray(data.scenes)) {
    return {
      ok: false,
      error: '课程快照数据不完整。',
      errorCode: 'SNAPSHOT_INVALID',
      status: 500,
    };
  }

  return {
    ok: true,
    data: {
      stage: data.stage,
      scenes: data.scenes.map(stripQuizAnswers),
      outlines: Array.isArray(data.outlines) ? data.outlines : [],
    },
    actor: entryActor,
  };
}

function stripQuizAnswers(scene: unknown): unknown {
  if (scene === null || typeof scene !== 'object') return scene;
  const source = scene as Record<string, unknown>;
  if (source.type !== 'quiz' || !source.content || typeof source.content !== 'object')
    return source;
  const content = source.content as Record<string, unknown>;
  if (!Array.isArray(content.questions)) return source;

  const questions = (content.questions as Array<Record<string, unknown>>).map((question) => {
    const safeQuestion = { ...question };
    delete safeQuestion.answer;
    delete safeQuestion.correctAnswer;
    delete safeQuestion.explanation;
    delete safeQuestion.correctOptions;
    return safeQuestion;
  });
  return { ...source, content: { ...content, questions } };
}
