import { NextRequest, NextResponse } from 'next/server';
import {
  createStudent,
  getErrorMessage,
  importStudents,
  listStudents,
  type StudentInput,
} from '@/lib/server/learning-mvp';

export async function GET() {
  try {
    const data = await listStudents();
    return NextResponse.json({ success: true, data });
  } catch (error: unknown) {
    return NextResponse.json(
      { success: false, error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const students = Array.isArray(body.students) ? (body.students as StudentInput[]) : null;
    const data = students ? await importStudents(students) : await createStudent(body);
    return NextResponse.json({ success: true, data });
  } catch (error: unknown) {
    return NextResponse.json(
      { success: false, error: getErrorMessage(error) },
      { status: 400 },
    );
  }
}
