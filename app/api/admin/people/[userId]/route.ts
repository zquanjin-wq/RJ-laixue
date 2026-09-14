import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/server/auth-context';
import { audit } from '@/lib/server/account-management';
import { getDatabasePool } from '@/lib/server/db/pool';

export async function PATCH(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const actor = await requireRole(['admin']);
    const { userId } = await context.params;
    const body = (await request.json()) as { organizationUnitId?: unknown };
    const organizationUnitId =
      typeof body.organizationUnitId === 'string' && body.organizationUnitId
        ? body.organizationUnitId
        : null;
    if (organizationUnitId) {
      const organization = await getDatabasePool().query(
        `SELECT 1 FROM app.organization_units WHERE id = $1 AND disabled_at IS NULL`,
        [organizationUnitId],
      );
      if (!organization.rowCount)
        return NextResponse.json({ error: '组织不存在或已停用。' }, { status: 400 });
    }
    const result = await getDatabasePool().query(
      `UPDATE app.user_profiles
          SET organization_unit_id = $2, updated_at = now()
        WHERE user_id = $1`,
      [userId, organizationUnitId],
    );
    if (!result.rowCount) return NextResponse.json({ error: '账号不存在。' }, { status: 404 });
    await audit(actor.userId, userId, 'person.organization_changed', organizationUnitId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return NextResponse.json(
      { error: message },
      { status: message === 'Unauthenticated' ? 401 : message === 'Forbidden' ? 403 : 400 },
    );
  }
}
