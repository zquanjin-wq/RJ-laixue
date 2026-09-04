import { NextResponse } from 'next/server';
import { getAuth } from '@/lib/server/auth';
import { generateInitialPassword, getLearner, requireAdmin } from '@/lib/server/admin-students';

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = await request.json() as { student_id?: unknown };
    const userId = typeof body.student_id === 'string' ? body.student_id : '';
    if (!userId || !await getLearner(userId)) return NextResponse.json({ success: false, errorCode: 'NOT_FOUND', error: '学员不存在。' }, { status: 404 });
    const initialPassword = generateInitialPassword();
    await getAuth().api.setUserPassword({ body: { userId, newPassword: initialPassword }, headers: request.headers });
    return NextResponse.json({ success: true, initial_password: initialPassword });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'Unauthenticated') return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED', error: '请先登录。' }, { status: 401 });
    if (message === 'Forbidden') return NextResponse.json({ success: false, errorCode: 'FORBIDDEN', error: '无权操作。' }, { status: 403 });
    console.error('[admin/students] password reset failed', error);
    return NextResponse.json({ success: false, errorCode: 'AUTH_UPDATE_FAILED', error: '重置密码失败。' }, { status: 500 });
  }
}
