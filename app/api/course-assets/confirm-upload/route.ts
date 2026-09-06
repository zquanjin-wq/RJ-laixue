import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrTeacher } from '@/lib/server/api-guard';
import { CosStorage } from '@/lib/server/cos-storage';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export const runtime = 'nodejs';

/** A signed PUT is only authorization; an asset becomes usable after COS confirms it exists. */
export async function POST(request: NextRequest) {
  const guard = await requireAuthOrTeacher(['teacher', 'admin']);
  if (!guard.ok) return guard.response;
  const body = (await request.json().catch(() => null)) as { path?: unknown } | null;
  const objectKey = typeof body?.path === 'string' ? body.path : '';
  if (!objectKey || objectKey.length > 1024) {
    return NextResponse.json({ success: false, error: '资产路径无效' }, { status: 400 });
  }
  const courses = new CourseRepository(getDatabasePool());
  const asset = await courses.getAssetByObjectKey(objectKey);
  if (!asset || asset.ownerUserId !== guard.user.id) {
    return NextResponse.json({ success: false, error: '资产不存在' }, { status: 404 });
  }
  try {
    await new CosStorage().assertObjectExists(objectKey);
    const ready = asset.state === 'ready' ? asset : await courses.markAssetReady(objectKey, guard.user.id);
    if (!ready) return NextResponse.json({ success: false, error: '资产状态无法确认' }, { status: 409 });
    return NextResponse.json({ success: true, data: { path: ready.objectKey, state: ready.state } });
  } catch {
    return NextResponse.json({ success: false, error: '资产尚未上传完成' }, { status: 409 });
  }
}
