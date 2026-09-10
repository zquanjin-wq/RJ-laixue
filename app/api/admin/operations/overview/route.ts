import { NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { getDatabasePool } from '@/lib/server/db/pool';
import { readOperationsOverview } from '@/lib/server/operations-overview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Admin-only, metadata-only production queue and recovery view. */
export async function GET() {
  const actor = await getCurrentActor();
  if (!actor) {
    return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  }
  if (actor.role !== 'admin') {
    return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });
  }

  try {
    return NextResponse.json({ success: true, data: await readOperationsOverview(getDatabasePool()) });
  } catch (error) {
    console.error('[operations-overview] read failed', error);
    return NextResponse.json(
      { success: false, errorCode: 'INTERNAL_ERROR', error: '读取运行概览失败。' },
      { status: 500 },
    );
  }
}
