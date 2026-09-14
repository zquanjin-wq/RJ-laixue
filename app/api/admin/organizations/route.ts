import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/server/auth-context';
import { audit, listOrganizationUnits } from '@/lib/server/account-management';
import { getDatabasePool } from '@/lib/server/db/pool';

export async function GET() {
  try {
    await requireRole(['admin']);
    return NextResponse.json({ organizations: await listOrganizationUnits() });
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireRole(['admin']);
    const body = (await request.json()) as { name?: unknown; parentId?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : null;
    if (!name) return NextResponse.json({ error: '请填写组织名称。' }, { status: 400 });
    if (parentId) {
      const parent = await getDatabasePool().query(
        `SELECT 1 FROM app.organization_units WHERE id = $1 AND disabled_at IS NULL`,
        [parentId],
      );
      if (!parent.rowCount)
        return NextResponse.json({ error: '上级组织不存在或已停用。' }, { status: 400 });
    }
    const result = await getDatabasePool().query<{ id: string }>(
      `INSERT INTO app.organization_units (name, parent_id) VALUES ($1, $2) RETURNING id::text`,
      [name, parentId],
    );
    await audit(actor.userId, null, 'organization.created', result.rows[0].id, { name, parentId });
    return NextResponse.json({ id: result.rows[0].id }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return NextResponse.json(
      { error: /unique|duplicate/i.test(message) ? '同一层级已有同名组织。' : message },
      { status: message === 'Unauthenticated' ? 401 : message === 'Forbidden' ? 403 : 400 },
    );
  }
}
