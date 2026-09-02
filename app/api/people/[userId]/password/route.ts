import { NextResponse } from 'next/server';
import { getAuth } from '@/lib/server/auth';
import { requireRole } from '@/lib/server/auth-context';
import { PeopleRepository } from '@/lib/server/db/people-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export async function POST(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    await requireRole(['admin']);
    const { userId } = await context.params;
    const body = (await request.json()) as { password?: string };
    if (!body.password)
      return NextResponse.json({ error: 'Password is required' }, { status: 400 });
    await getAuth().api.setUserPassword({
      body: { userId, newPassword: body.password },
      headers: request.headers,
    });
    await new PeopleRepository(getDatabasePool()).setMustChangePassword(userId, true);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to set password' },
      { status: 400 },
    );
  }
}
