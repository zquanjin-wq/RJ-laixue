import { NextRequest, NextResponse } from 'next/server';
import { runNextCourseVideoExport } from '@/lib/server/course-video-export-worker';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const expected = process.env.COURSE_VIDEO_EXPORT_WORKER_TOKEN;
  if (!expected || request.headers.get('authorization') !== `Bearer ${expected}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ success: true, processed: await runNextCourseVideoExport() });
}
