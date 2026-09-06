import { NextRequest, NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { getDatabasePool } from '@/lib/server/db/pool';
import { ClassroomGenerationRepository } from '@/lib/server/db/classroom-generation-repository';

export const runtime = 'nodejs';
type Context = { params: Promise<{ jobId: string }> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handle(context: Context, cancel: boolean) {
  const actor = await getCurrentActor();
  if (!actor) return NextResponse.json({ errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  const { jobId } = await context.params;
  if (!uuid.test(jobId)) return NextResponse.json({ errorCode: 'NOT_FOUND' }, { status: 404 });
  const jobs = new ClassroomGenerationRepository(getDatabasePool());
  const job = await jobs.getOwned(jobId, actor.userId);
  if (!job) return NextResponse.json({ errorCode: 'NOT_FOUND' }, { status: 404 });
  if (cancel) {
    await jobs.cancel(jobId, actor.userId);
    return NextResponse.json(await jobs.getOwned(jobId, actor.userId));
  }
  return NextResponse.json(job);
}

export async function GET(_request: NextRequest, context: Context) {
  return handle(context, false);
}
export async function DELETE(_request: NextRequest, context: Context) {
  return handle(context, true);
}
