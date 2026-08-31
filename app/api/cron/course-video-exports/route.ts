import { NextRequest, NextResponse } from 'next/server';
import { reconcileCourseVideoExportJobs } from '@/lib/server/course-video-export-jobs';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ success: false }, { status: 401 });
  }
  try {
    return NextResponse.json({ success: true, ...(await reconcileCourseVideoExportJobs()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '视频任务收尾失败';
    console.error('[course-video-export] worker failed', { message });
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
