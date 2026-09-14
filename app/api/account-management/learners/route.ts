import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth-context';
import {
  createManagedLearner,
  generateInitialPassword,
  listManagedPeople,
} from '@/lib/server/account-management';

export async function GET() {
  try {
    const actor = await requireUser();
    return NextResponse.json({ people: await listManagedPeople(actor) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return NextResponse.json(
      { error: message },
      { status: message === 'Unauthenticated' ? 401 : 403 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireUser();
    const body = (await request.json()) as {
      email?: unknown;
      displayName?: unknown;
      organizationUnitId?: unknown;
    };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    const organizationUnitId =
      typeof body.organizationUnitId === 'string' ? body.organizationUnitId : '';
    if (!email.includes('@') || !displayName || !organizationUnitId) {
      return NextResponse.json({ error: '请填写姓名、有效邮箱和所属组织。' }, { status: 400 });
    }
    const initialPassword = generateInitialPassword();
    const user = await createManagedLearner(actor, {
      email,
      displayName,
      organizationUnitId,
      password: initialPassword,
    });
    return NextResponse.json({ userId: user.id, email, initialPassword }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status =
      message === 'Unauthenticated'
        ? 401
        : message === 'Forbidden'
          ? 403
          : /unique|exists|duplicate/i.test(message)
            ? 409
            : 400;
    return NextResponse.json(
      { error: status === 409 ? '该邮箱已被使用。' : message || '创建学员失败。' },
      { status },
    );
  }
}
