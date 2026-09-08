import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveApiToken } from '@/lib/server/api-token';
import { CosStorage } from '@/lib/server/cos-storage';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { getDatabasePool } from '@/lib/server/db/pool';
import { PptxSourceRepository } from '@/lib/server/db/pptx-source-repository';

export const runtime = 'nodejs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requestSchema = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => /\.pptx$/i.test(value)),
});

/** Confirm a direct COS upload and turn the immutable asset into a PPTX source. */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ assetId: string }> },
) {
  const pool = getDatabasePool();
  const actor = await resolveApiToken(pool, request.headers.get('authorization'));
  if (!actor || actor.role === 'learner' || !actor.scopes.includes('classroom:write')) {
    return NextResponse.json({ errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const { assetId } = await context.params;
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!uuid.test(assetId) || !parsed.success) {
    return NextResponse.json({ errorCode: 'INVALID_REQUEST' }, { status: 400 });
  }
  const courses = new CourseRepository(pool);
  const result = await pool.query<{
    id: string;
    ownerUserId: string;
    objectKey: string;
    state: string;
    kind: string;
    contentType: string;
  }>(
    `SELECT id, owner_user_id AS "ownerUserId", object_key AS "objectKey", state, kind,
            content_type AS "contentType"
       FROM app.course_assets
      WHERE id=$1 AND deleted_at IS NULL`,
    [assetId],
  );
  const assetRow = result.rows[0];
  if (
    !assetRow ||
    assetRow.ownerUserId !== actor.userId ||
    assetRow.kind !== 'material' ||
    assetRow.contentType !==
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return NextResponse.json({ errorCode: 'NOT_FOUND' }, { status: 404 });
  }
  try {
    await new CosStorage().assertObjectExists(assetRow.objectKey);
    if (assetRow.state !== 'ready') await courses.markAssetReady(assetRow.objectKey, actor.userId);
    const source = await new PptxSourceRepository(pool).register({
      ownerUserId: actor.userId,
      assetId,
      originalFilename: parsed.data.fileName,
    });
    return NextResponse.json({ sourceId: source.id, status: source.status });
  } catch {
    return NextResponse.json({ errorCode: 'SOURCE_NOT_READY' }, { status: 409 });
  }
}
