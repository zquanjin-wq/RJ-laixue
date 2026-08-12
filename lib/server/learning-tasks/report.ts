export type LearnerReportRow = {
  studentId: string;
  name: string;
  status: 'not_started' | 'in_progress' | 'completed';
  progressPercent: number;
  masteryPercent: number | null;
  effectiveSeconds: number;
  lastSeenAt: string | null;
};

export type LearningEventRow = {
  student_id: string;
  event_type: string;
  scene_id: string | null;
};

export type ReportScene = { id: string; title: string; order: number | null };

function numberOrZero(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

export function learnerDisplayStatus(
  learner: Pick<LearnerReportRow, 'status'>,
  dueAt: string | null,
  now = new Date(),
) {
  if (learner.status === 'completed') return 'completed' as const;
  if (dueAt && new Date(dueAt) < now) return 'overdue' as const;
  return learner.status;
}

export function buildTaskReport(input: {
  dueAt: string | null;
  learners: LearnerReportRow[];
  events?: LearningEventRow[];
  scenes?: ReportScene[];
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const learners = input.learners.map((learner) => ({
    ...learner,
    displayStatus: learnerDisplayStatus(learner, input.dueAt, now),
  }));
  const total = learners.length;
  const started = input.learners.filter((learner) => learner.status !== 'not_started').length;
  const completed = learners.filter((learner) => learner.displayStatus === 'completed').length;
  const inProgress = learners.filter((learner) => learner.displayStatus === 'in_progress').length;
  const notStarted = learners.filter((learner) => learner.displayStatus === 'not_started').length;
  const overdue = learners.filter((learner) => learner.displayStatus === 'overdue').length;
  const effectiveSeconds = learners.reduce((sum, learner) => sum + learner.effectiveSeconds, 0);

  const events = input.events ?? [];
  const chapters = (input.scenes ?? []).map((scene) => {
    const completedBy = new Set(
      events
        .filter((event) => event.event_type === 'scene_completed' && event.scene_id === scene.id)
        .map((event) => event.student_id),
    );
    const questionsAsked = events.filter(
      (event) => event.event_type === 'question_asked' && event.scene_id === scene.id,
    ).length;
    return {
      ...scene,
      completedLearners: completedBy.size,
      completionRate: total === 0 ? 0 : Math.round((completedBy.size / total) * 100),
      questionsAsked,
    };
  });

  return {
    overview: {
      total,
      notStarted,
      inProgress,
      completed,
      overdue,
      startRate: total === 0 ? 0 : Math.round((started / total) * 100),
      completionRate: total === 0 ? 0 : Math.round((completed / total) * 100),
      effectiveSeconds,
    },
    learners,
    chapters,
  };
}

export function toLearnerReportRow(row: Record<string, unknown>, name: string): LearnerReportRow {
  return {
    studentId: String(row.student_id ?? ''),
    name: name || '未命名学员',
    status: row.status === 'completed' || row.status === 'in_progress' ? row.status : 'not_started',
    progressPercent: numberOrZero(row.progress_percent),
    masteryPercent: row.mastery_percent == null ? null : numberOrZero(row.mastery_percent),
    effectiveSeconds: numberOrZero(row.effective_seconds),
    lastSeenAt: typeof row.last_seen_at === 'string' ? row.last_seen_at : null,
  };
}
