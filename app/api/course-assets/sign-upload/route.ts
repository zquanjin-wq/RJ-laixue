import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  MATERIAL_EXTENSIONS,
  MATERIAL_MAX_BYTES,
  MATERIAL_MIME_TYPES,
  type CourseAssetKind as ClientAssetKind,
} from '@/lib/course-assets/shared';
import { requireAuthOrTeacher } from '@/lib/server/api-guard';
import { CosStorage } from '@/lib/server/cos-storage';
import { CourseRepository, type CourseAssetKind } from '@/lib/server/db/course-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export const runtime = 'nodejs';

const MIME_TYPES: Record<Exclude<ClientAssetKind, 'material'>, RegExp> = {
  images: /^image\/(png|jpeg|gif|webp|svg\+xml)$/,
  audio: /^audio\/(mpeg|mp3|wav|ogg|webm|mp4|aac)$/,
};

const databaseKinds: Record<ClientAssetKind, CourseAssetKind> = {
  images: 'image',
  audio: 'audio',
  material: 'material',
};

function isAllowedType(kind: ClientAssetKind, contentType: string, extension: string): boolean {
  const normalizedType = contentType.toLowerCase().split(';')[0].trim();
  if (kind === 'material') {
    return (
      (Object.values(MATERIAL_MIME_TYPES).includes(normalizedType) ||
        normalizedType === 'text/plain') &&
      MATERIAL_EXTENSIONS.has(extension)
    );
  }
  return MIME_TYPES[kind].test(normalizedType);
}

export async function POST(request: NextRequest) {
  try {
    const guard = await requireAuthOrTeacher(['teacher', 'admin']);
    if (!guard.ok) return guard.response;

    const body = (await request.json()) as {
      courseId?: string;
      kind?: ClientAssetKind;
      contentType?: string;
      extension?: string;
      size?: number;
    };
    const { courseId, kind, contentType, size } = body;
    const extension = body.extension?.toLowerCase();

    if (!courseId || !kind || !contentType || !extension || !Number.isFinite(size) || size! <= 0) {
      return NextResponse.json({ success: false, error: '资产上传参数无效' }, { status: 400 });
    }
    if (!['images', 'audio', 'material'].includes(kind) || !/^[a-z0-9]{2,10}$/.test(extension)) {
      return NextResponse.json({ success: false, error: '资产上传参数格式无效' }, { status: 400 });
    }
    if (!isAllowedType(kind, contentType, extension)) {
      return NextResponse.json({ success: false, error: '不支持此文件类型' }, { status: 400 });
    }
    if (size! > MATERIAL_MAX_BYTES) {
      return NextResponse.json({ success: false, error: '文件超过 49MB' }, { status: 413 });
    }

    const courses = new CourseRepository(getDatabasePool());
    const temporary = /^pending-[a-zA-Z0-9_-]{1,32}$/.test(courseId);
    let boundCourseId: string | null = null;
    let prefix: string;

    if (temporary) {
      prefix = `pending/${guard.user.id}/${kind}`;
    } else {
      const course = await courses.getCourse(courseId);
      if (!course) {
        return NextResponse.json({ success: false, error: '课程不存在' }, { status: 404 });
      }
      if (course.ownerUserId !== guard.user.id && guard.role !== 'admin') {
        return NextResponse.json(
          { success: false, error: '您没有权限上传此课程的资产' },
          { status: 403 },
        );
      }
      boundCourseId = course.id;
      prefix = `courses/${course.id}/${kind}`;
    }

    const objectKey = `${prefix}/${randomUUID()}.${extension}`;
    await courses.createAsset({
      ownerUserId: guard.user.id,
      courseId: boundCourseId,
      kind: databaseKinds[kind],
      objectKey,
      contentType,
      sizeBytes: size!,
    });

    const uploadUrl = await new CosStorage().getUploadUrl(objectKey);
    const assetUrl = `/api/course-assets/object?key=${encodeURIComponent(objectKey)}`;
    return NextResponse.json({
      success: true,
      data: { path: objectKey, uploadUrl, publicUrl: assetUrl },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '资产上传授权失败' },
      { status: 500 },
    );
  }
}
