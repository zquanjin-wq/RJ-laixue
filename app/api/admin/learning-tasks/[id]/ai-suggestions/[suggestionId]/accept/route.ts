import { NextRequest, NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { AccessRepository } from '@/lib/server/db/access-repository';
import { LearningAnalyticsRepository } from '@/lib/server/db/learning-analytics-repository';
import { getDatabasePool } from '@/lib/server/db/pool';
import { TaskRepository } from '@/lib/server/db/task-repository';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string; suggestionId: string }> }) {
  const { id: taskId, suggestionId } = await params;
  const actor = await getCurrentActor();
  if (!actor) return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  const pool = getDatabasePool();
  if (!(await new AccessRepository(pool).canManageTask(actor, taskId))) return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });
  try {
    const analytics = new LearningAnalyticsRepository(pool);
    const suggestion = await analytics.getSuggestion(taskId, suggestionId);
    if (!suggestion) return NextResponse.json({ success: false, errorCode: 'SUGGESTION_NOT_FOUND' }, { status: 404 });
    if (suggestion.created_task_id) return NextResponse.json({ success: true, data: { taskId: suggestion.created_task_id, reused: true } });
    const source = await analytics.getTask(taskId);
    const sourceData = await analytics.getTaskAnalytics(taskId);
    if (!source) return NextResponse.json({ success: false, errorCode: 'TASK_NOT_FOUND' }, { status: 404 });
    const createdTaskId = await new TaskRepository(pool).createTask({ title: `Remedial: ${source.title}`, description: suggestion.reason, createdBy: actor.userId, taskType: 'remedial', sourceTaskId: taskId, courses: sourceData.courses.map((course) => ({ courseId: course.course_id, isRequired: course.is_required })), userIds: suggestion.learner_ids });
    if (!(await analytics.acceptSuggestion(suggestionId, createdTaskId))) return NextResponse.json({ success: true, data: { taskId: createdTaskId, reused: true } });
    return NextResponse.json({ success: true, data: { taskId: createdTaskId, status: 'draft' } }, { status: 201 });
  } catch (error) {
    console.error('[ai-suggestion] accept failed:', error);
    return NextResponse.json({ success: false, errorCode: 'CREATE_REMEDIAL_FAILED' }, { status: 500 });
  }
}
