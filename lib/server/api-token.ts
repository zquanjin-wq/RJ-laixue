import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseActor } from './db/access-repository';

export const API_TOKEN_PREFIX = 'laix_';
export type ApiTokenScope = 'classroom:read' | 'classroom:write';

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function issueApiToken() {
  const secret = randomBytes(32).toString('base64url');
  return `${API_TOKEN_PREFIX}${secret}`;
}

export async function resolveApiToken(pool: Pool, authorization: string | null): Promise<(DatabaseActor & { tokenId: string; scopes: ApiTokenScope[] }) | null> {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7).trim();
  if (!token.startsWith(API_TOKEN_PREFIX)) return null;
  const row = await pool.query<{ id: string; ownerUserId: string; scopes: ApiTokenScope[] }>(
    `UPDATE app.api_tokens token SET last_used_at=now()
     FROM app.user_profiles profile JOIN public."user" u ON u.id=profile.user_id
     WHERE token.token_hash=$1 AND token.owner_user_id=profile.user_id
       AND token.revoked_at IS NULL AND (token.expires_at IS NULL OR token.expires_at>now())
       AND u.banned IS NOT TRUE
     RETURNING token.id,token.owner_user_id AS "ownerUserId",token.scopes,profile.role`,
    [hashToken(token)],
  );
  const item = row.rows[0] as (typeof row.rows[number] & { role: DatabaseActor['role'] }) | undefined;
  if (!item) return null;
  return { userId: item.ownerUserId, role: item.role, tokenId: item.id, scopes: item.scopes };
}

export async function createApiToken(pool: Pool, ownerUserId: string, name: string) {
  const token = issueApiToken();
  const prefix = token.slice(0, 16);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO app.api_tokens (owner_user_id,name,token_prefix,token_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [ownerUserId, name.trim(), prefix, hashToken(token)],
  );
  return { id: result.rows[0].id, token, prefix };
}
