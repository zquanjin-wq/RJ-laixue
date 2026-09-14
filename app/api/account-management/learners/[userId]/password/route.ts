import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth-context';
import {
  generateInitialPassword,
  resetManagedLearnerPassword,
} from '@/lib/server/account-management';

export async function POST(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const actor = await requireUser();
    const { userId } = await context.params;
    const password = generateInitialPassword();
    await resetManagedLearnerPassword(actor, userId, password, request.headers);
    return NextResponse.json({ ok: true, initialPassword: password });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status = message === 'Unauthenticated' ? 401 : message === 'NotFound' ? 404 : 403;
    return NextResponse.json({ error: message || '重置密码失败。' }, { status });
  }
}
