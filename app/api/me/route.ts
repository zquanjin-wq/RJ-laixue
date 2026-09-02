import { NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { PeopleRepository } from '@/lib/server/db/people-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export async function GET() {
  const actor = await getCurrentActor();
  if (!actor) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });
  }
  const person = await new PeopleRepository(getDatabasePool()).getPerson(actor.userId);
  return NextResponse.json({
    actor: { ...actor, mustChangePassword: person?.mustChangePassword ?? false },
  });
}
