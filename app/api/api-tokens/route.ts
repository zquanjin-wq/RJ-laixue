import { NextRequest, NextResponse } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { createApiToken } from '@/lib/server/api-token';
import { getDatabasePool } from '@/lib/server/db/pool';

export const runtime = 'nodejs';

export async function GET() {
  const actor = await getCurrentActor();
  if (!actor) return NextResponse.json({ errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  const result = await getDatabasePool().query(
    `SELECT id,name,token_prefix AS "tokenPrefix",scopes,expires_at AS "expiresAt",revoked_at AS "revokedAt",last_used_at AS "lastUsedAt",created_at AS "createdAt"
     FROM app.api_tokens WHERE owner_user_id=$1 ORDER BY created_at DESC`,
    [actor.userId],
  );
  return NextResponse.json({ tokens: result.rows });
}

export async function POST(request: NextRequest) {
  const actor = await getCurrentActor();
  if (!actor) return NextResponse.json({ errorCode: 'UNAUTHENTICATED' }, { status: 401 });
  if (actor.role === 'learner') return NextResponse.json({ errorCode: 'FORBIDDEN' }, { status: 403 });
  const body = await request.json().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 80) return NextResponse.json({ errorCode: 'INVALID_NAME' }, { status: 400 });
  const created = await createApiToken(getDatabasePool(), actor.userId, name);
  return NextResponse.json(created, { status: 201 });
}
