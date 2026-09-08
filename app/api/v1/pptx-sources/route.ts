import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveApiToken } from '@/lib/server/api-token';
import { CosStorage } from '@/lib/server/cos-storage';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { getDatabasePool } from '@/lib/server/db/pool';

export const runtime = 'nodejs';

const requestSchema = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => /\.pptx$/i.test(value)),
  sizeBytes: z.number().int().positive().max(49_000_000),
});

/**
 * First step of the API/Skill PPTX flow. The caller uploads the original PPTX
 * directly to COS, then confirms it through the asset-specific PATCH route.
 */
export async function POST(request: NextRequest) {
  const pool = getDatabasePool();
  const actor = await resolveApiToken(pool, request.headers.get('authorization'));
  if (!actor || actor.role === 'learner' || !actor.scopes.includes('classroom:write')) {
    return NextResponse.json({ errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ errorCode: 'INVALID_REQUEST' }, { status: 400 });

  const objectKey = `pending/${actor.userId}/material/${randomUUID()}.pptx`;
  const asset = await new CourseRepository(pool).createAsset({
    ownerUserId: actor.userId,
    kind: 'material',
    objectKey,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    sizeBytes: parsed.data.sizeBytes,
  });
  const uploadUrl = await new CosStorage().getUploadUrl(objectKey);
  return NextResponse.json(
    {
      assetId: asset.id,
      uploadUrl,
      confirmUrl: `/api/v1/pptx-sources/${asset.id}`,
      expiresInSeconds: 900,
    },
    { status: 201 },
  );
}
