import { NextRequest, NextResponse } from 'next/server';
import { runNextCourseRevoiceJob } from '@/lib/server/course-revoice-jobs';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ success: false }, { status: 401 });
  }
  try {
    const job = await runNextCourseRevoiceJob();
    return NextResponse.json({
      success: true,
      job: job
        ? {
            id: job.id,
            status: job.status,
            completed: job.completed_items,
            total: job.total_items,
          }
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown revoice worker error';
    console.error('[course-revoice-worker] execution failed', { message });
    // The external scheduler must receive a non-2xx response so its own retry
    // and alerting policy can see a failed worker invocation.
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
