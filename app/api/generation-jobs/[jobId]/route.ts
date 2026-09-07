import { NextRequest, NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { getDatabasePool } from '@/lib/server/db/pool';
import { ClassroomGenerationRepository } from '@/lib/server/db/classroom-generation-repository';

export const runtime = 'nodejs';
type Context = { params: Promise<{ jobId: string }> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handle(request: NextRequest, context: Context, action: 'read' | 'cancel' | 'retry') {
  const actor = await getCurrentActor();
  if (!actor) return NextResponse.json({ errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  const { jobId } = await context.params;
  if (!uuid.test(jobId)) return NextResponse.json({ errorCode: 'NOT_FOUND' }, { status: 404 });
  const jobs = new ClassroomGenerationRepository(getDatabasePool());
  const job = await jobs.getOwned(jobId, actor.userId);
  if (!job) return NextResponse.json({ errorCode: 'NOT_FOUND' }, { status: 404 });
  if (action === 'cancel') {
    await jobs.cancel(jobId, actor.userId);
    return NextResponse.json(await jobs.getOwned(jobId, actor.userId));
  }
  if (action === 'retry') {
    const retried = await jobs.retry(jobId, actor.userId);
    if (!retried) return NextResponse.json({ errorCode: 'JOB_NOT_RETRYABLE' }, { status: 409 });
    return NextResponse.json(await jobs.getOwned(jobId, actor.userId), { status: 202 });
  }
  const after = Number(new URL(request.url).searchParams.get('after') ?? '0');
  const events = await jobs.listOwnedEvents(jobId, actor.userId, Number.isSafeInteger(after) ? after : 0);
  return NextResponse.json({ ...job, events, nextEventId: events.at(-1)?.id ?? after });
}

export async function GET(_request: NextRequest, context: Context) {
  return handle(_request, context, 'read');
}
export async function DELETE(_request: NextRequest, context: Context) {
  return handle(_request, context, 'cancel');
}
export async function POST(_request: NextRequest, context: Context) {
  return handle(_request, context, 'retry');
}
