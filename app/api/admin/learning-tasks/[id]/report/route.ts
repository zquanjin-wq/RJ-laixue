import { NextRequest, NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { AccessRepository } from '@/lib/server/db/access-repository';
import { LearningAnalyticsRepository } from '@/lib/server/db/learning-analytics-repository';
import { getDatabasePool } from '@/lib/server/db/pool';
import { buildTaskReport, toLearnerReportRow } from '@/lib/server/learning-tasks/report';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getCurrentActor();
    if (!actor) return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED' }, { status: 401 });
    const { id: taskId } = await params;
    const pool = getDatabasePool();
    if (!(await new AccessRepository(pool).canManageTask(actor, taskId))) {
      return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });
    }
    const analytics = new LearningAnalyticsRepository(pool);
    const task = await analytics.getTask(taskId);
    if (!task) return NextResponse.json({ success: false, errorCode: 'TASK_NOT_FOUND' }, { status: 404 });
    const data = await analytics.getTaskAnalytics(taskId);
    const courses = data.courses.map((course) => {
      const rows = data.progress.filter((row) => row.course_id === course.course_id);
      const completed = rows.filter((row) => row.status === 'completed').length;
      const started = rows.filter((row) => row.status !== 'not_started').length;
      return {
        courseId: course.course_id,
        title: course.title,
        position: course.position,
        isRequired: course.is_required,
        learnerCount: rows.length,
        startedCount: started,
        completedCount: completed,
        completionRate: rows.length ? Math.round((completed / rows.length) * 100) : 0,
        effectiveSeconds: rows.reduce((total, row) => total + Number(row.effective_seconds ?? 0), 0),
      };
    });
    const report = buildTaskReport({
      dueAt: task.due_at,
      learners: data.learners.map((row) => toLearnerReportRow(row, row.name)),
    });
    return NextResponse.json({ success: true, data: { overview: report.overview, learners: report.learners, courses } });
  } catch (error) {
    console.error('[admin/learning-tasks/report] get failed:', error);
    return NextResponse.json({ success: false, errorCode: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
