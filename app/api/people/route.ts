import { NextResponse } from 'next/server';
import { getAuth } from '@/lib/server/auth';
import { requireRole } from '@/lib/server/auth-context';
import type { AppRole } from '@/lib/server/db/access-repository';
import { PeopleRepository } from '@/lib/server/db/people-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export async function GET() {
  try {
    await requireRole(['admin']);
    return NextResponse.json({
      people: await new PeopleRepository(getDatabasePool()).listPeople(),
    });
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
}

export async function POST(request: Request) {
  try {
    await requireRole(['admin']);
    const body = (await request.json()) as {
      email?: string;
      password?: string;
      displayName?: string;
      role?: AppRole;
      employeeNo?: string;
      department?: string;
    };
    if (!body.email || !body.password || !body.displayName || !body.role) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const created = await getAuth().api.createUser({
      body: {
        email: body.email,
        password: body.password,
        name: body.displayName,
        role: body.role === 'admin' ? 'admin' : 'user',
      },
    });
    try {
      await new PeopleRepository(getDatabasePool()).createProfile({
        userId: created.user.id,
        role: body.role,
        displayName: body.displayName,
        employeeNo: body.employeeNo,
        department: body.department,
      });
    } catch (error) {
      await getAuth().api.removeUser({ body: { userId: created.user.id } });
      throw error;
    }
    return NextResponse.json({ userId: created.user.id }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to create account' },
      { status: 400 },
    );
  }
}
