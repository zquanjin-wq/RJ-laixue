import { NextResponse } from 'next/server';
import { getAuth } from '@/lib/server/auth';
import { requireRole } from '@/lib/server/auth-context';
import type { AppRole } from '@/lib/server/db/access-repository';
import { PeopleRepository } from '@/lib/server/db/people-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export async function PATCH(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    await requireRole(['admin']);
    const { userId } = await context.params;
    const body = (await request.json()) as {
      role?: AppRole;
      displayName?: string;
      employeeNo?: string | null;
      department?: string | null;
      disabled?: boolean;
      mustChangePassword?: boolean;
    };

    if (body.disabled === true) await getAuth().api.banUser({ body: { userId } });
    if (body.disabled === false) await getAuth().api.unbanUser({ body: { userId } });

    if (body.role && body.displayName) {
      await getAuth().api.setRole({
        body: { userId, role: body.role === 'admin' ? 'admin' : 'user' },
        headers: request.headers,
      });
      const updated = await new PeopleRepository(getDatabasePool()).updateProfile(userId, {
        role: body.role,
        displayName: body.displayName,
        employeeNo: body.employeeNo,
        department: body.department,
        mustChangePassword: body.mustChangePassword,
      });
      if (!updated) return NextResponse.json({ error: 'Person not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to update account' },
      { status: 400 },
    );
  }
}
