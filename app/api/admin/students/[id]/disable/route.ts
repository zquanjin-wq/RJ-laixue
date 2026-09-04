import { NextResponse } from 'next/server';
import { requireAdmin, setLearnerDisabled } from '@/lib/server/admin-students';

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    if (!await setLearnerDisabled((await params).id, true)) return NextResponse.json({ success: false, errorCode: 'NOT_FOUND', error: '学员不存在。' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return NextResponse.json({ success: false, errorCode: message === 'Unauthenticated' ? 'UNAUTHENTICATED' : 'FORBIDDEN', error: '无权操作。' }, { status: message === 'Unauthenticated' ? 401 : 403 });
  }
}
