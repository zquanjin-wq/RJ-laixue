import { NextRequest, NextResponse } from 'next/server';
import { getDatabasePool } from '@/lib/server/db/pool';
import { resolveApiToken } from '@/lib/server/api-token';
import { ClassroomGenerationRepository } from '@/lib/server/db/classroom-generation-repository';

export const runtime = 'nodejs';
export async function GET(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const actor = await resolveApiToken(getDatabasePool(), request.headers.get('authorization'));
  if (!actor || !actor.scopes.includes('classroom:read')) return NextResponse.json({ errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  const { jobId } = await context.params;
  const jobs = new ClassroomGenerationRepository(getDatabasePool());
  const job = await jobs.getOwned(jobId, actor.userId);
  if (!job) return NextResponse.json({ errorCode: 'NOT_FOUND' }, { status: 404 });
  const after = Number(request.nextUrl.searchParams.get('after') ?? '0');
  const events = await jobs.listOwnedEvents(jobId, actor.userId, Number.isSafeInteger(after) ? after : 0);
  return NextResponse.json({ ...job, events, nextEventId: events.at(-1)?.id ?? after });
}
