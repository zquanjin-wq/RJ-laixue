import { NextRequest, NextResponse } from 'next/server';
import {
  assignCourse,
  getErrorMessage,
  listCourseAssignments,
} from '@/lib/server/learning-mvp';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const data = await listCourseAssignments(id);
    return NextResponse.json({ success: true, data });
  } catch (error: unknown) {
    return NextResponse.json(
      { success: false, error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const studentIds = Array.isArray(body.studentIds) ? (body.studentIds as string[]) : [];
    const data = await assignCourse(id, studentIds);
    return NextResponse.json({ success: true, data });
  } catch (error: unknown) {
    return NextResponse.json(
      { success: false, error: getErrorMessage(error) },
      { status: 400 },
    );
  }
}
