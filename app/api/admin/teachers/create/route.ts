import { NextResponse } from 'next/server';
import { createTeacher, generateInitialPassword, requireAdmin } from '@/lib/server/admin-teachers';

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = await request.json() as { name?: unknown; email?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!name || !email.includes('@')) return NextResponse.json({ success: false, errorCode: 'INVALID_REQUEST', error: '请填写有效的姓名和邮箱。' }, { status: 400 });
    const initialPassword = generateInitialPassword();
    const user = await createTeacher({ name, email, password: initialPassword });
    return NextResponse.json({ success: true, user_id: user.id, email, initial_password: initialPassword });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'Unauthenticated') return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED', error: '请先登录。' }, { status: 401 });
    if (message === 'Forbidden') return NextResponse.json({ success: false, errorCode: 'FORBIDDEN', error: '只有管理员可以创建老师。' }, { status: 403 });
    if (/unique|exists|duplicate/i.test(message)) return NextResponse.json({ success: false, errorCode: 'EMAIL_TAKEN', error: '该邮箱已被使用。' }, { status: 409 });
    console.error('[admin/teachers] create failed', error);
    return NextResponse.json({ success: false, errorCode: 'INTERNAL_ERROR', error: '创建老师失败。' }, { status: 500 });
  }
}
