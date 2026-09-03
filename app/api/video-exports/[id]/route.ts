import { NextRequest, NextResponse } from 'next/server';
import {
  requireVideoExportManager,
  unavailableVideoExportResponse,
  validateVideoExportIdentifier,
} from '@/lib/export/video-export-api';
import { getVideoExportService } from '@/lib/export/video-export-service';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { CourseVideoExportRepository } from '@/lib/server/db/course-video-export-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export const runtime = 'nodejs';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const access = await requireVideoExportManager();
  if ('response' in access) return access.response;
  const { id } = await context.params;
  const exportId = validateVideoExportIdentifier(id);
  if (!exportId.success) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: '无效的视频导出标识。' },
      { status: 400 },
    );
  }
  const service = getVideoExportService();
  const capability = await service.getCapability();
  if (!capability.available) {
    return unavailableVideoExportResponse(capability);
  }
  const exportJob = await service.getById(exportId.data);
  if (!exportJob) {
    return NextResponse.json(
      { success: false, errorCode: 'NOT_FOUND', error: '视频导出任务不存在。' },
      { status: 404 },
    );
  }
  const course = await new CourseRepository(getDatabasePool()).getCourse(exportJob.courseId);
  if (!course || (course.ownerUserId !== access.actor.userId && access.actor.role !== 'admin')) {
    return NextResponse.json({ success: false, errorCode: 'NOT_FOUND', error: '视频导出任务不存在。' }, { status: 404 });
  }
  return NextResponse.json({ success: true, export: exportJob });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const access = await requireVideoExportManager();
  if ('response' in access) return access.response;
  const { id } = await context.params;
  const parsed = validateVideoExportIdentifier(id);
  if (!parsed.success) return NextResponse.json({ success: false, errorCode: 'INVALID_REQUEST', error: '无效的视频导出标识。' }, { status: 400 });
  const repository = new CourseVideoExportRepository(getDatabasePool());
  const current = await repository.get(parsed.data);
  if (!current) return NextResponse.json({ success: false, errorCode: 'NOT_FOUND', error: '视频导出任务不存在。' }, { status: 404 });
  const course = await new CourseRepository(getDatabasePool()).getCourse(current.courseId);
  if (!course || (course.ownerUserId !== access.actor.userId && access.actor.role !== 'admin')) return NextResponse.json({ success: false, errorCode: 'NOT_FOUND', error: '视频导出任务不存在。' }, { status: 404 });
  const body = await request.json().catch(() => null) as { action?: string } | null;
  const next = body?.action === 'retry'
    ? await repository.retry(current.id)
    : body?.action === 'cancel'
      ? await repository.updateStatus({ id: current.id, status: 'cancelled', expectedStatuses: ['queued', 'running'] })
      : null;
  if (!next) return NextResponse.json({ success: false, errorCode: 'INVALID_REQUEST', error: '当前任务无法执行该操作。' }, { status: 409 });
  return NextResponse.json({ success: true, export: await getVideoExportService().getById(next.id) });
}
