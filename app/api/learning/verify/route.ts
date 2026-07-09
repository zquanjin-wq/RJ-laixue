import { NextRequest, NextResponse } from 'next/server';
import { getErrorMessage, verifyStudentAccess } from '@/lib/server/learning-mvp';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const courseId = typeof body.courseId === 'string' ? body.courseId : '';
    const accessCode = typeof body.accessCode === 'string' ? body.accessCode.trim().toUpperCase() : '';

    if (!courseId || !accessCode) {
      return NextResponse.json(
        { success: false, error: 'Missing courseId or accessCode' },
        { status: 400 },
      );
    }

    const data = await verifyStudentAccess(courseId, accessCode);
    return NextResponse.json({ success: true, data });
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    const status = msg.includes('not assigned') ? 403 : msg.includes('not found') ? 404 : 400;
    return NextResponse.json({ success: false, error: msg }, { status });
  }
}
