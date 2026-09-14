import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth-context';
import { setManagedLearnerDisabled } from '@/lib/server/account-management';

export async function PATCH(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const actor = await requireUser();
    const { userId } = await context.params;
    const body = (await request.json()) as { disabled?: unknown };
    if (typeof body.disabled !== 'boolean') {
      return NextResponse.json({ error: '缺少账号状态。' }, { status: 400 });
    }
    await setManagedLearnerDisabled(actor, userId, body.disabled);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status = message === 'Unauthenticated' ? 401 : message === 'NotFound' ? 404 : 403;
    return NextResponse.json({ error: message || '更新账号失败。' }, { status });
  }
}
