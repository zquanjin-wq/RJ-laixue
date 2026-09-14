import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth-context';
import { updateManagedPerson } from '@/lib/server/account-management';

export async function PATCH(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const actor = await requireUser();
    const { userId } = await context.params;
    const body = (await request.json()) as {
      displayName?: unknown;
      email?: unknown;
      organizationUnitId?: unknown;
    };
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const organizationUnitId =
      typeof body.organizationUnitId === 'string' && body.organizationUnitId
        ? body.organizationUnitId
        : null;
    if (!displayName || !email.includes('@')) {
      return NextResponse.json({ error: '请填写姓名和有效邮箱。' }, { status: 400 });
    }
    await updateManagedPerson(actor, userId, { displayName, email, organizationUnitId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status =
      message === 'Unauthenticated'
        ? 401
        : message === 'Forbidden'
          ? 403
          : message === 'NotFound'
            ? 404
            : /unique|duplicate/i.test(message)
              ? 409
              : 400;
    return NextResponse.json(
      { error: status === 409 ? '该邮箱已被使用。' : message || '更新账号失败。' },
      { status },
    );
  }
}
