import { NextRequest, NextResponse } from 'next/server';
import {
  parseVideoExportRequest,
  requireVideoExportManager,
  unavailableVideoExportResponse,
  validateVideoExportIdentifier,
} from '@/lib/export/video-export-api';
import {
  getVideoExportService,
  VideoRendererNotConfiguredError,
} from '@/lib/export/video-export-service';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const access = await requireVideoExportManager();
  if ('response' in access) return access.response;
  const { id } = await context.params;
  const courseId = validateVideoExportIdentifier(id);
  if (!courseId.success) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: '无效的课程标识。' },
      { status: 400 },
    );
  }
  const course = await new CourseRepository(getDatabasePool()).getCourse(courseId.data);
  if (!course || (course.ownerUserId !== access.actor.userId && access.actor.role !== 'admin')) {
    return NextResponse.json(
      { success: false, errorCode: 'NOT_FOUND', error: '课程不存在' },
      { status: 404 },
    );
  }
  const service = getVideoExportService();
  const exports = await service.listForCourse(courseId.data);
  return NextResponse.json({ success: true, capability: await service.getCapability(), exports });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const access = await requireVideoExportManager();
  if ('response' in access) return access.response;
  const { id } = await context.params;
  const courseId = validateVideoExportIdentifier(id);
  if (!courseId.success) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: '无效的课程标识。' },
      { status: 400 },
    );
  }
  const course = await new CourseRepository(getDatabasePool()).getCourse(courseId.data);
  if (!course || (course.ownerUserId !== access.actor.userId && access.actor.role !== 'admin')) {
    return NextResponse.json(
      { success: false, errorCode: 'NOT_FOUND', error: '课程不存在' },
      { status: 404 },
    );
  }
  const parsed = await parseVideoExportRequest(request, courseId.data, access.actor.userId);
  if ('response' in parsed) return parsed.response;
  const service = getVideoExportService();
  try {
    const exportJob = await service.request(parsed.input);
    return NextResponse.json({ success: true, export: exportJob }, { status: 202 });
  } catch (error) {
    if (error instanceof VideoRendererNotConfiguredError) {
      return unavailableVideoExportResponse(await service.getCapability());
    }
    throw error;
  }
}
