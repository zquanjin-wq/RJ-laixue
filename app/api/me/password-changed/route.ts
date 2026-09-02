import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth-context';
import { PeopleRepository } from '@/lib/server/db/people-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export async function POST() {
  const actor = await requireUser();
  await new PeopleRepository(getDatabasePool()).setMustChangePassword(actor.userId, false);
  return NextResponse.json({ ok: true });
}
