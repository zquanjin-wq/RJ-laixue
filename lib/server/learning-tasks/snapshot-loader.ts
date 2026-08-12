/**
 * 任务快照加载器（Gate 1B）
 *
 * 服务端共享函数：根据 taskId 从 course_snapshots 读取不可变快照，
 * 并做身份、任务状态和时间窗口校验。
 *
 * 返回结构与 /api/classroom、/api/courses/[id] 返回的 course data 兼容：
 *   { stage, scenes, outlines }
 *
 * 安全约束：
 *   - 必须从已登录用户解析身份；
 *   - 学员必须在 task_learners 名单内且未禁用；
 *   - admin/teacher 仅作为 preview 进入；
 *   - 校验任务状态（published）和时间窗口；
 *   - 不返回标准答案或内部字段；
 *   - 不接受客户端 studentId。
 */
import { getServiceSupabase } from '@/lib/supabase/server';
import { resolveActor } from './permissions';

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
): Promise<SnapshotLoadResult> {
  const svc = getServiceSupabase();

  // 1. 读取任务及其 snapshot
  const { data: task, error: taskError } = await svc
    .from('learning_tasks')
    .select('id, course_id, status, start_at, due_at, snapshot_id, share_token')
    .eq('id', taskId)
    .maybeSingle();

  if (taskError) {
    return { ok: false, error: '查询任务失败', errorCode: 'INTERNAL_ERROR', status: 500 };
  }
  if (!task) {
    return { ok: false, error: '任务不存在', errorCode: 'TASK_NOT_FOUND', status: 404 };
  }

  // 2. 任务状态校验
  if (task.status === 'archived' || task.status === 'closed') {
    return { ok: false, error: '任务已结束', errorCode: 'TASK_CLOSED', status: 403 };
  }
  if (task.status !== 'published') {
    return { ok: false, error: '任务尚未发布', errorCode: 'TASK_NOT_PUBLISHED', status: 403 };
  }

  // 3. 解析身份
  const actor = await resolveActor(userId);
  let entryActor: 'learner' | 'preview';

  if (actor.role === 'admin') {
    entryActor = 'preview';
  } else if (actor.role === 'teacher') {
    const { data: ownedTask } = await svc
      .from('learning_tasks')
      .select('id')
      .eq('id', taskId)
      .eq('created_by', userId)
      .maybeSingle();

    if (!ownedTask) {
      return { ok: false, error: '无权预览此学习任务', errorCode: 'TASK_NOT_OWNED', status: 403 };
    }
    entryActor = 'preview';
  } else {
    // learner：校验学员绑定与名单
    const { data: student, error: studentError } = await svc
      .from('students')
      .select('id, disabled_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (studentError) {
      return { ok: false, error: '查询学员失败', errorCode: 'INTERNAL_ERROR', status: 500 };
    }
    if (!student) {
      return { ok: false, error: '账号未绑定学员', errorCode: 'LEARNER_NOT_BOUND', status: 403 };
    }
    if (student.disabled_at) {
      return { ok: false, error: '学员账号已停用', errorCode: 'LEARNER_DISABLED', status: 403 };
    }

    const { data: taskLearner, error: tlError } = await svc
      .from('task_learners')
      .select('id')
      .eq('task_id', taskId)
      .eq('student_id', student.id)
      .maybeSingle();

    if (tlError) {
      return { ok: false, error: '查询学员名单失败', errorCode: 'INTERNAL_ERROR', status: 500 };
    }
    if (!taskLearner) {
      return {
        ok: false,
        error: '你不在该任务的学员名单中',
        errorCode: 'LEARNER_NOT_ASSIGNED',
        status: 403,
      };
    }

    entryActor = 'learner';
  }

  // 4. 时间窗口校验（仅对 learner）
  if (entryActor === 'learner' && task.start_at && new Date(task.start_at) > new Date()) {
    return { ok: false, error: '任务尚未开始', errorCode: 'TASK_NOT_STARTED', status: 403 };
  }
  if (entryActor === 'learner' && task.due_at && new Date(task.due_at) < new Date()) {
    // Gate 1B 允许截止后进入，仅做提示；不阻止。
  }

  // 5. 读取快照
  if (!task.snapshot_id) {
    return { ok: false, error: '任务未绑定课程快照', errorCode: 'SNAPSHOT_MISSING', status: 500 };
  }

  const { data: snapshot, error: snapshotError } = await svc
    .from('course_snapshots')
    .select('snapshot_data')
    .eq('id', task.snapshot_id)
    .maybeSingle();

  if (snapshotError || !snapshot) {
    return { ok: false, error: '课程快照不存在', errorCode: 'SNAPSHOT_NOT_FOUND', status: 404 };
  }

  const data = (snapshot.snapshot_data ?? {}) as {
    stage?: unknown;
    scenes?: unknown;
    outlines?: unknown;
  };

  if (!data.stage || !Array.isArray(data.scenes)) {
    return { ok: false, error: '快照数据不完整', errorCode: 'SNAPSHOT_INVALID', status: 500 };
  }

  // 6. 安全视图：移除标准答案等内部字段
  const safeScenes = data.scenes.map((s: unknown) => stripQuizAnswers(s));

  return {
    ok: true,
    data: {
      stage: data.stage,
      scenes: safeScenes,
      outlines: Array.isArray(data.outlines) ? data.outlines : [],
    },
    actor: entryActor,
  };
}

/**
 * 移除检查题标准答案等内部字段。
 * 保留结构和呈现所需字段，避免泄漏答案。
 */
function stripQuizAnswers(scene: unknown): unknown {
  if (scene === null || typeof scene !== 'object') return scene;
  const s = scene as Record<string, unknown>;

  if (s.type !== 'quiz' || !s.content || typeof s.content !== 'object') return s;

  const content = s.content as Record<string, unknown>;
  if (!Array.isArray(content.questions)) return s;

  const questions = (content.questions as Array<Record<string, unknown>>).map((q) => {
    const copy = { ...q };
    delete copy.answer;
    delete copy.correctAnswer;
    delete copy.explanation;
    delete copy.correctOptions;
    return copy;
  });

  return {
    ...s,
    content: {
      ...content,
      questions,
    },
  };
}
