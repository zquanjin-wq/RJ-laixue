import { getServiceSupabase } from '@/lib/supabase/server';
import { checkTaskEntryPermission } from '@/lib/server/learning-tasks/permissions';

export type TaskLearningEventType =
  | 'task_opened'
  | 'scene_started'
  | 'scene_completed'
  | 'heartbeat'
  | 'question_asked'
  | 'check_submitted'
  | 'check_reviewed'
  | 'task_completed';

export interface TaskLearningEventInput {
  taskId: string;
  courseId: string;
  eventType: TaskLearningEventType;
  clientEventId: string;
  sceneId?: string;
  sceneOrder?: number;
  metadata?: Record<string, unknown>;
}

export type TaskLearningResult =
  | { ok: true; recorded: false; reason: 'preview'; role: 'admin' | 'teacher' }
  | {
      ok: true;
      recorded: true;
      progressPercent: number;
      masteryPercent: number | null;
      completed: boolean;
    }
  | { ok: false; error: string; errorCode: string; status: number };

function quizSceneIds(snapshot: unknown): string[] {
  const data = snapshot as { scenes?: Array<{ id?: unknown; type?: unknown; content?: unknown }> };
  return (data.scenes ?? [])
    .filter((scene) => {
      if (scene.type !== 'quiz' || !scene.content || typeof scene.content !== 'object')
        return false;
      return Array.isArray((scene.content as { questions?: unknown }).questions);
    })
    .map((scene) => scene.id)
    .filter((id): id is string => typeof id === 'string');
}

function sceneIds(snapshot: unknown): string[] {
  const data = snapshot as { scenes?: Array<{ id?: unknown; type?: unknown }> };
  return (data.scenes ?? [])
    .filter((scene) => scene.type === 'slide' || scene.type == null)
    .map((scene) => scene.id)
    .filter((id): id is string => typeof id === 'string');
}

export async function recordTaskLearningEvent(
  userId: string,
  input: TaskLearningEventInput,
): Promise<TaskLearningResult> {
  const svc = getServiceSupabase();
  const permission = await checkTaskEntryPermission(userId, input.taskId);
  if (!permission.ok) {
    const code =
      permission.reason === 'learner_not_bound'
        ? 'LEARNER_NOT_BOUND'
        : permission.reason === 'learner_disabled'
          ? 'LEARNER_DISABLED'
          : 'LEARNER_NOT_ASSIGNED';
    return { ok: false, error: '无权记录此学习任务', errorCode: code, status: 403 };
  }
  if (permission.actor === 'preview') {
    return { ok: true, recorded: false, reason: 'preview', role: permission.role };
  }

  const { data: task, error: taskError } = await svc
    .from('learning_tasks')
    .select('id, course_id, status, snapshot_id')
    .eq('id', input.taskId)
    .maybeSingle();
  if (taskError || !task)
    return { ok: false, error: '任务不存在', errorCode: 'TASK_NOT_FOUND', status: 404 };
  if (task.status !== 'published') {
    return { ok: false, error: '任务当前不可学习', errorCode: 'TASK_NOT_ACTIVE', status: 403 };
  }

  const { data: taskCourse } = await svc
    .from('task_courses')
    .select('snapshot_id, is_required')
    .eq('task_id', input.taskId)
    .eq('course_id', input.courseId)
    .maybeSingle();
  const snapshotId =
    taskCourse?.snapshot_id ?? (task.course_id === input.courseId ? task.snapshot_id : null);
  if (!snapshotId)
    return { ok: false, error: '课程不在此任务中', errorCode: 'COURSE_NOT_IN_TASK', status: 403 };

  const { data: snapshot } = await svc
    .from('course_snapshots')
    .select('snapshot_data')
    .eq('id', snapshotId)
    .maybeSingle();
  if (!snapshot)
    return { ok: false, error: '任务快照不可用', errorCode: 'SNAPSHOT_NOT_FOUND', status: 404 };

  const { error: insertError } = await svc.from('task_learning_events').insert({
    task_id: input.taskId,
    course_id: input.courseId,
    student_id: permission.studentId,
    client_event_id: input.clientEventId,
    event_type: input.eventType,
    scene_id: input.sceneId ?? null,
    scene_order: input.sceneOrder ?? null,
    payload: input.metadata ?? {},
  });
  if (insertError) {
    if ((insertError as { code?: string }).code === '23505') {
      const { data: learner } = await svc
        .from('task_learners')
        .select('progress_percent, mastery_percent, status')
        .eq('id', permission.taskLearnerId)
        .maybeSingle();
      return {
        ok: true,
        recorded: true,
        progressPercent: Number(learner?.progress_percent ?? 0),
        masteryPercent: learner?.mastery_percent == null ? null : Number(learner.mastery_percent),
        completed: learner?.status === 'completed',
      };
    }
    throw insertError;
  }

  const { data: events, error: eventsError } = await svc
    .from('task_learning_events')
    .select('event_type, scene_id, payload')
    .eq('task_id', input.taskId)
    .eq('course_id', input.courseId)
    .eq('student_id', permission.studentId);
  if (eventsError) throw eventsError;

  const rows = events ?? [];
  const completedScenes = new Set(
    rows
      .filter((row) => row.event_type === 'scene_completed' && row.scene_id)
      .map((row) => row.scene_id),
  );
  const submittedChecks = new Set(
    rows
      .filter((row) => row.event_type === 'check_submitted' && row.scene_id)
      .map((row) => row.scene_id),
  );
  const reviewedChecks = new Set(
    rows
      .filter((row) => row.event_type === 'check_reviewed' && row.scene_id)
      .map((row) => row.scene_id),
  );
  const allScenes = sceneIds(snapshot.snapshot_data);
  const requiredSceneIds = new Set(allScenes);
  const completedRequiredScenes = [...completedScenes].filter((sceneId) =>
    requiredSceneIds.has(sceneId),
  );
  const requiredChecks = quizSceneIds(snapshot.snapshot_data);
  const progressPercent =
    allScenes.length === 0
      ? 0
      : Math.round((completedRequiredScenes.length / allScenes.length) * 100);
  const checksReady = requiredChecks.every(
    (sceneId) => submittedChecks.has(sceneId) && reviewedChecks.has(sceneId),
  );
  const completed = completedRequiredScenes.length >= allScenes.length && checksReady;

  const results = rows.flatMap((row) => {
    if (row.event_type !== 'check_reviewed') return [] as Array<{ correct?: unknown }>;
    const payload = row.payload as { results?: unknown } | null;
    return Array.isArray(payload?.results) ? (payload.results as Array<{ correct?: unknown }>) : [];
  });
  const graded = results.filter((result) => typeof result.correct === 'boolean');
  const masteryPercent =
    graded.length > 0
      ? Math.round((graded.filter((result) => result.correct).length / graded.length) * 100)
      : null;
  const activeSeconds =
    input.eventType === 'heartbeat' && typeof input.metadata?.activeSeconds === 'number'
      ? Math.max(0, Math.min(30, Math.round(input.metadata.activeSeconds)))
      : 0;
  const now = new Date().toISOString();
  const coursePatch: Record<string, unknown> = {
    status: completed ? 'completed' : 'in_progress',
    progress_percent: progressPercent,
    completed_scene_count: completedRequiredScenes.length,
    total_scene_count: allScenes.length,
    last_seen_at: now,
    last_scene_id: input.sceneId ?? null,
    mastery_percent: masteryPercent,
  };
  if (input.eventType === 'task_opened') coursePatch.started_at = now;
  if (completed) coursePatch.completed_at = now;
  if (activeSeconds > 0) {
    const { data: courseProgressRow } = await svc
      .from('task_course_progress')
      .select('effective_seconds')
      .eq('task_id', input.taskId)
      .eq('student_id', permission.studentId)
      .eq('course_id', input.courseId)
      .maybeSingle();
    coursePatch.effective_seconds =
      Number(courseProgressRow?.effective_seconds ?? 0) + activeSeconds;
  }
  const { error: courseUpdateError } = await svc
    .from('task_course_progress')
    .update(coursePatch)
    .eq('task_id', input.taskId)
    .eq('student_id', permission.studentId)
    .eq('course_id', input.courseId);
  if (courseUpdateError) throw courseUpdateError;

  const { data: courseProgress } = await svc
    .from('task_course_progress')
    .select('course_id, status, progress_percent, effective_seconds')
    .eq('task_id', input.taskId)
    .eq('student_id', permission.studentId);
  const { data: requiredCourses } = await svc
    .from('task_courses')
    .select('course_id')
    .eq('task_id', input.taskId)
    .eq('is_required', true);
  const requiredIds = new Set((requiredCourses ?? []).map((item) => item.course_id));
  const requiredProgress = (courseProgress ?? []).filter((item) => requiredIds.has(item.course_id));
  const taskCompleted =
    requiredProgress.length > 0 && requiredProgress.every((item) => item.status === 'completed');
  const taskProgress = requiredProgress.length
    ? Math.round(
        requiredProgress.reduce((sum, item) => sum + Number(item.progress_percent ?? 0), 0) /
          requiredProgress.length,
      )
    : 0;
  const totalEffectiveSeconds = (courseProgress ?? []).reduce(
    (sum, item) => sum + Number(item.effective_seconds ?? 0),
    0,
  );
  const taskPatch: Record<string, unknown> = {
    status: taskCompleted ? 'completed' : 'in_progress',
    progress_percent: taskProgress,
    effective_seconds: totalEffectiveSeconds,
    last_seen_at: now,
  };
  if (input.eventType === 'task_opened') taskPatch.started_at = now;
  if (taskCompleted) taskPatch.completed_at = now;
  const { error: updateError } = await svc
    .from('task_learners')
    .update(taskPatch)
    .eq('id', permission.taskLearnerId);
  if (updateError) throw updateError;

  return { ok: true, recorded: true, progressPercent, masteryPercent, completed };
}
