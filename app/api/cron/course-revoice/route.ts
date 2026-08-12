import { NextRequest, NextResponse } from 'next/server';
import { runNextCourseRevoiceJob } from '@/lib/server/course-revoice-jobs';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ success: false }, { status: 401 });
  }
  const job = await runNextCourseRevoiceJob();
  return NextResponse.json({ success: true, jobId: job?.id ?? null });
}
