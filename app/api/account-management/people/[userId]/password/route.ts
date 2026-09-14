import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth-context';
import {
  generateInitialPassword,
  resetManagedPersonPassword,
} from '@/lib/server/account-management';

export async function POST(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const actor = await requireUser();
    const { userId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    const provided = typeof body.password === 'string' ? body.password : '';
    if (provided && provided.length < 8) {
      return NextResponse.json({ error: '密码至少 8 位。' }, { status: 400 });
    }
    const password = provided || generateInitialPassword();
    await resetManagedPersonPassword(actor, userId, password, request.headers);
    return NextResponse.json({ ok: true, initialPassword: password });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status =
      message === 'Unauthenticated'
        ? 401
        : message === 'Forbidden'
          ? 403
          : message === 'NotFound'
            ? 404
            : 400;
    return NextResponse.json({ error: message || '修改密码失败。' }, { status });
  }
}
