import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { MATERIAL_MAX_BYTES } from '@/lib/course-assets/shared';
import { getCurrentActor } from '@/lib/server/auth-context';
import { CosStorage } from '@/lib/server/cos-storage';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export const runtime = 'nodejs';

function audioExtension(fileName: string, contentType: string) {
  const fromName = fileName.split('.').pop()?.toLowerCase();
  if (fromName && /^[a-z0-9]{2,10}$/.test(fromName)) return fromName;
  if (contentType === 'audio/wav') return 'wav';
  if (contentType === 'audio/ogg') return 'ogg';
  if (contentType === 'audio/webm') return 'webm';
  return 'mp3';
}

export async function POST(request: NextRequest) {
  try {
    const actor = await getCurrentActor();
    if (!actor) return NextResponse.json({ error: '请先登录后再上传音频' }, { status: 401 });
    if (actor.role === 'learner') {
      return NextResponse.json({ error: '学员不能上传课程音频' }, { status: 403 });
    }

    const formData = await request.formData();
    const file = formData.get('file');
    const stageId = formData.get('stageId');
    if (!(file instanceof File) || !file.type.startsWith('audio/')) {
      return NextResponse.json({ error: '请上传音频文件' }, { status: 400 });
    }
    if (file.size > MATERIAL_MAX_BYTES) {
      return NextResponse.json({ error: '音频文件超过 49MB' }, { status: 413 });
    }

    const courses = new CourseRepository(getDatabasePool());
    const courseId = typeof stageId === 'string' && stageId ? stageId : null;
    const course = courseId ? await courses.getCourse(courseId) : null;
    if (course && course.ownerUserId !== actor.userId && actor.role !== 'admin') {
      return NextResponse.json({ error: '您没有权限上传此课程的音频' }, { status: 403 });
    }

    const ext = audioExtension(file.name, file.type);
    const objectKey = course
      ? `courses/${course.id}/audio/${randomUUID()}.${ext}`
      : `uploads/${actor.userId}/audio/${randomUUID()}.${ext}`;
    const bytes = Buffer.from(await file.arrayBuffer());
    await new CosStorage().putObject(objectKey, bytes, file.type);
    await courses.createAsset({
      ownerUserId: actor.userId,
      courseId: course?.id ?? null,
      kind: 'audio',
      objectKey,
      contentType: file.type,
      sizeBytes: file.size,
    });

    return NextResponse.json({
      url: `/api/course-assets/object?key=${encodeURIComponent(objectKey)}`,
      path: objectKey,
      fileName: file.name,
      contentType: file.type,
      size: file.size,
      stageId: course?.id ?? undefined,
    });
  } catch (error) {
    return NextResponse.json(
      { error: '音频上传失败', details: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
