import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrTeacher } from '@/lib/server/api-guard';
import { CosStorage } from '@/lib/server/cos-storage';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const guard = await requireAuthOrTeacher(['admin', 'teacher', 'learner']);
  if (!guard.ok) return guard.response;

  const objectKey = request.nextUrl.searchParams.get('key');
  if (!objectKey) {
    return NextResponse.json({ success: false, error: '缺少资产路径' }, { status: 400 });
  }

  const courses = new CourseRepository(getDatabasePool());
  const asset = await courses.getAssetByObjectKey(objectKey);
  if (!asset || asset.state === 'deleted') {
    return NextResponse.json({ success: false, error: '资产不存在' }, { status: 404 });
  }
  if (guard.role !== 'admin' && guard.role !== 'learner' && asset.ownerUserId !== guard.user.id) {
    return NextResponse.json({ success: false, error: '您没有权限访问此资产' }, { status: 403 });
  }

  const location = await new CosStorage().getDownloadUrl(objectKey);
  return NextResponse.redirect(location, 307);
}
