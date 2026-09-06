import { NextRequest, NextResponse } from 'next/server';
import { getDatabasePool } from '@/lib/server/db/pool';
import { runDurableClassroomOnce } from '@/lib/server/durable-classroom-worker';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ success: false }, { status: 401 });
  }
  if (process.env.CLASSROOM_GENERATION_ENABLED !== 'true') {
    return NextResponse.json(
      { success: false, errorCode: 'GENERATION_NOT_ENABLED' },
      { status: 503 },
    );
  }
  try {
    const origin = new URL(process.env.BETTER_AUTH_URL || request.nextUrl.origin).origin;
    const worked = await runDurableClassroomOnce(
      getDatabasePool(),
      `cron-${crypto.randomUUID()}`,
      origin,
    );
    return NextResponse.json({ success: true, worked });
  } catch (error) {
    console.error('[classroom-generation-worker] invocation failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json({ success: false, errorCode: 'WORKER_FAILED' }, { status: 500 });
  }
}
