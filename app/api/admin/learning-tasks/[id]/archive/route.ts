import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth-context';
import { AccessRepository } from '@/lib/server/db/access-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireUser();
    const taskId = (await params).id;
    if (!await new AccessRepository(getDatabasePool()).canManageTask(actor, taskId)) return NextResponse.json({ success: false, errorCode: 'FORBIDDEN', error: '无权归档此任务。' }, { status: 403 });
    const result = await getDatabasePool().query<{ status: string }>(
      `UPDATE app.learning_tasks SET status = CASE status WHEN 'draft' THEN 'archived' WHEN 'published' THEN 'closed' WHEN 'closed' THEN 'archived' ELSE status END, updated_at = now()
       WHERE id = $1 RETURNING status`,
      [taskId],
    );
    if (!result.rowCount) return NextResponse.json({ success: false, errorCode: 'TASK_NOT_FOUND', error: '任务不存在。' }, { status: 404 });
    return NextResponse.json({ success: true, data: { id: taskId, status: result.rows[0].status } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return NextResponse.json({ success: false, errorCode: message === 'Unauthenticated' ? 'UNAUTHENTICATED' : 'INTERNAL_ERROR', error: message === 'Unauthenticated' ? '请先登录。' : '归档任务失败。' }, { status: message === 'Unauthenticated' ? 401 : 500 });
  }
}
