import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/server/auth-context';
import { audit } from '@/lib/server/account-management';
import { getDatabasePool } from '@/lib/server/db/pool';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireRole(['admin']);
    const { id } = await context.params;
    const body = (await request.json()) as { name?: unknown; disabled?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : undefined;
    if (name !== undefined && !name)
      return NextResponse.json({ error: '组织名称不能为空。' }, { status: 400 });

    if (body.disabled === true) {
      const usage = await getDatabasePool().query<{ members: number; children: number }>(
        `SELECT
           (SELECT count(*)::integer FROM app.user_profiles WHERE organization_unit_id = $1) AS members,
           (SELECT count(*)::integer FROM app.organization_units WHERE parent_id = $1 AND disabled_at IS NULL) AS children`,
        [id],
      );
      if (!usage.rows[0]) return NextResponse.json({ error: '组织不存在。' }, { status: 404 });
      if (usage.rows[0].members || usage.rows[0].children)
        return NextResponse.json(
          { error: '请先移出该组织的成员并停用或移动下级组织。' },
          { status: 409 },
        );
    }

    const result = await getDatabasePool().query(
      `UPDATE app.organization_units
          SET name = COALESCE($2, name),
              disabled_at = CASE WHEN $3::boolean IS TRUE THEN now() WHEN $3::boolean IS FALSE THEN NULL ELSE disabled_at END,
              updated_at = now()
        WHERE id = $1`,
      [id, name ?? null, typeof body.disabled === 'boolean' ? body.disabled : null],
    );
    if (!result.rowCount) return NextResponse.json({ error: '组织不存在。' }, { status: 404 });
    await audit(
      actor.userId,
      null,
      name
        ? 'organization.renamed'
        : body.disabled
          ? 'organization.disabled'
          : 'organization.enabled',
      id,
      { name },
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return NextResponse.json(
      { error: /unique|duplicate/i.test(message) ? '同一层级已有同名组织。' : message },
      { status: message === 'Unauthenticated' ? 401 : message === 'Forbidden' ? 403 : 400 },
    );
  }
}
