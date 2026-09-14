import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/server/auth-context';
import { audit } from '@/lib/server/account-management';
import { getDatabasePool } from '@/lib/server/db/pool';

export async function POST(request: Request) {
  try {
    const actor = await requireRole(['admin']);
    const body = (await request.json()) as {
      userId?: unknown;
      organizationUnitId?: unknown;
      includeDescendants?: unknown;
      enabled?: unknown;
    };
    const userId = typeof body.userId === 'string' ? body.userId : '';
    const organizationUnitId =
      typeof body.organizationUnitId === 'string' ? body.organizationUnitId : '';
    if (!userId || typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: '授权参数不完整。' }, { status: 400 });
    }
    const teacher = await getDatabasePool().query<{ organizationUnitId: string | null }>(
      `SELECT organization_unit_id::text AS "organizationUnitId"
         FROM app.user_profiles WHERE user_id = $1 AND role = 'teacher'`,
      [userId],
    );
    if (!teacher.rowCount) return NextResponse.json({ error: '只能给教师授权。' }, { status: 400 });
    if (body.enabled) {
      if (!organizationUnitId)
        return NextResponse.json({ error: '请选择管理范围。' }, { status: 400 });
      if (teacher.rows[0].organizationUnitId !== organizationUnitId)
        return NextResponse.json(
          { error: '教师只能管理自己所属组织及下级组织。' },
          { status: 400 },
        );
      const organization = await getDatabasePool().query(
        `SELECT 1 FROM app.organization_units WHERE id = $1 AND disabled_at IS NULL`,
        [organizationUnitId],
      );
      if (!organization.rowCount)
        return NextResponse.json({ error: '组织不存在或已停用。' }, { status: 400 });
      await getDatabasePool().query(
        `INSERT INTO app.account_management_grants
           (user_id, organization_unit_id, include_descendants, granted_by, revoked_at)
         VALUES ($1, $2, $3, $4, NULL)
         ON CONFLICT (user_id) DO UPDATE SET
           organization_unit_id = EXCLUDED.organization_unit_id,
           include_descendants = EXCLUDED.include_descendants,
           granted_by = EXCLUDED.granted_by,
           created_at = now(), revoked_at = NULL`,
        [userId, organizationUnitId, body.includeDescendants !== false, actor.userId],
      );
    } else {
      await getDatabasePool().query(
        `UPDATE app.account_management_grants SET revoked_at = now() WHERE user_id = $1`,
        [userId],
      );
    }
    await audit(
      actor.userId,
      userId,
      body.enabled ? 'grant.enabled' : 'grant.revoked',
      organizationUnitId || null,
      { includeDescendants: body.includeDescendants !== false },
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return NextResponse.json(
      { error: message },
      { status: message === 'Unauthenticated' ? 401 : message === 'Forbidden' ? 403 : 400 },
    );
  }
}
