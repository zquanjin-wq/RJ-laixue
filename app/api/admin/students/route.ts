/**
 * GET /api/admin/students
 *
 * 返回学员列表（id, name, email, disabled_at），供教师选择学习任务学员。
 * Admin 返回全部，teacher 返回未禁用的学员（管理员为任务分配用）。
 */
import { NextResponse } from 'next/server';
import { listLearners, requireAdmin } from '@/lib/server/admin-students';

export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json({ success: true, data: await listLearners() });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';
    return NextResponse.json(
      { success: false, error: message === 'Unauthenticated' ? '请先登录。' : '无权获取学员列表。' },
      { status: message === 'Unauthenticated' ? 401 : 403 },
    );
  }
}
