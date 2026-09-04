import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth-context';
import { AccessRepository } from '@/lib/server/db/access-repository';
import { getDatabasePool } from '@/lib/server/db/pool';
import { TaskRepository } from '@/lib/server/db/task-repository';

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireUser();
    const taskId = (await params).id;
    if (!await new AccessRepository(getDatabasePool()).canManageTask(actor, taskId)) {
      return NextResponse.json({ success: false, errorCode: 'FORBIDDEN', error: '无权发布此任务。' }, { status: 403 });
    }
    const result = await new TaskRepository(getDatabasePool()).publishTask(taskId, actor.userId);
    return NextResponse.json({ success: true, data: { id: result.taskId, status: 'published', share_token: result.shareToken, published: result.publishedAt } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'Unauthenticated') return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED', error: '请先登录。' }, { status: 401 });
    if (message === 'Task not found') return NextResponse.json({ success: false, errorCode: 'TASK_NOT_FOUND', error: '任务不存在。' }, { status: 404 });
    if (/Only draft/.test(message)) return NextResponse.json({ success: false, errorCode: 'TASK_NOT_DRAFT', error: '非草稿状态不可发布。' }, { status: 400 });
    if (/requires courses and learners/.test(message)) return NextResponse.json({ success: false, errorCode: 'TASK_EMPTY_ROSTER', error: '任务必须包含课件和学员。' }, { status: 400 });
    console.error('[admin/learning-tasks] publish failed', error);
    return NextResponse.json({ success: false, errorCode: 'INTERNAL_ERROR', error: '发布任务失败。' }, { status: 500 });
  }
}
