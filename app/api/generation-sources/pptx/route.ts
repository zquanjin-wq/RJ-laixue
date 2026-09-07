import { NextRequest, NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { getDatabasePool } from '@/lib/server/db/pool';
import { PptxSourceRepository } from '@/lib/server/db/pptx-source-repository';

export const runtime = 'nodejs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const actor = await getCurrentActor();
  if (!actor) return NextResponse.json({ errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  if (actor.role === 'learner')
    return NextResponse.json({ errorCode: 'FORBIDDEN' }, { status: 403 });
  const body = (await request.json().catch(() => null)) as {
    assetId?: unknown;
    fileName?: unknown;
  } | null;
  const assetId = typeof body?.assetId === 'string' ? body.assetId : '';
  const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
  if (!uuid.test(assetId) || !fileName || fileName.length > 255 || !/\.pptx$/i.test(fileName)) {
    return NextResponse.json({ errorCode: 'INVALID_REQUEST' }, { status: 400 });
  }
  try {
    const source = await new PptxSourceRepository(getDatabasePool()).register({
      ownerUserId: actor.userId,
      assetId,
      originalFilename: fileName,
    });
    return NextResponse.json({ sourceId: source.id, status: source.status }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { errorCode: 'SOURCE_NOT_READY' },
      { status: error instanceof Error && error.message.includes('not owned') ? 404 : 409 },
    );
  }
}
