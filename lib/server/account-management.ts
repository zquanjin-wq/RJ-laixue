import { randomBytes } from 'node:crypto';
import type { AuthenticatedActor } from '@/lib/server/auth-context';
import { getAuth } from '@/lib/server/auth';
import { getDatabasePool } from '@/lib/server/db/pool';

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

export function generateInitialPassword(length = 12): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]).join('');
}

export type OrganizationUnit = {
  id: string;
  name: string;
  parentId: string | null;
  disabled: boolean;
};

export type ManagedPerson = {
  userId: string;
  email: string;
  displayName: string;
  role: 'admin' | 'teacher' | 'learner';
  organizationUnitId: string | null;
  organizationName: string | null;
  mustChangePassword: boolean;
  banned: boolean;
  canManageAccounts: boolean;
  grantOrganizationUnitId: string | null;
  includeDescendants: boolean;
};

export type AccountAuditEvent = {
  id: string;
  actorName: string;
  targetName: string | null;
  action: string;
  organizationName: string | null;
  createdAt: string;
};

export async function getAccountManagementAccess(actor: AuthenticatedActor) {
  if (actor.role === 'admin') return { kind: 'admin' as const };
  if (actor.role !== 'teacher') return null;
  const result = await getDatabasePool().query<{
    organizationUnitId: string;
    includeDescendants: boolean;
  }>(
    `SELECT organization_unit_id::text AS "organizationUnitId",
            include_descendants AS "includeDescendants"
       FROM app.account_management_grants
       JOIN app.organization_units o ON o.id = organization_unit_id
      WHERE user_id = $1 AND revoked_at IS NULL AND o.disabled_at IS NULL`,
    [actor.userId],
  );
  return result.rows[0] ? { kind: 'teacher' as const, ...result.rows[0] } : null;
}

export async function listOrganizationUnits(): Promise<OrganizationUnit[]> {
  const result = await getDatabasePool().query<OrganizationUnit>(
    `SELECT id::text, name, parent_id::text AS "parentId", disabled_at IS NOT NULL AS disabled
       FROM app.organization_units
      ORDER BY created_at, name`,
  );
  return result.rows;
}

export async function listManageableOrganizationUnits(
  actor: AuthenticatedActor,
): Promise<OrganizationUnit[]> {
  const access = await getAccountManagementAccess(actor);
  if (!access) throw new Error('Forbidden');
  if (access.kind === 'admin') return listOrganizationUnits();
  const result = await getDatabasePool().query<OrganizationUnit>(
    access.includeDescendants
      ? `WITH RECURSIVE descendants AS (
           SELECT id, name, parent_id, disabled_at FROM app.organization_units WHERE id = $1
           UNION ALL
           SELECT child.id, child.name, child.parent_id, child.disabled_at
             FROM app.organization_units child JOIN descendants parent ON child.parent_id = parent.id
         ) SELECT id::text, name, parent_id::text AS "parentId", disabled_at IS NOT NULL AS disabled FROM descendants ORDER BY name`
      : `SELECT id::text, name, parent_id::text AS "parentId", disabled_at IS NOT NULL AS disabled
           FROM app.organization_units WHERE id = $1`,
    [access.organizationUnitId],
  );
  return result.rows;
}

export async function listManagedPeople(actor: AuthenticatedActor): Promise<ManagedPerson[]> {
  const access = await getAccountManagementAccess(actor);
  if (!access) throw new Error('Forbidden');
  const params: unknown[] = [];
  let scope = '';
  if (access.kind === 'teacher') {
    params.push(access.organizationUnitId);
    scope = access.includeDescendants
      ? `AND p.role = 'learner' AND p.organization_unit_id IN (
           WITH RECURSIVE descendants AS (
             SELECT id FROM app.organization_units WHERE id = $1 AND disabled_at IS NULL
             UNION ALL
             SELECT child.id FROM app.organization_units child JOIN descendants parent ON child.parent_id = parent.id
              WHERE child.disabled_at IS NULL
           ) SELECT id FROM descendants
         )`
      : `AND p.role = 'learner' AND p.organization_unit_id = $1`;
  }
  const result = await getDatabasePool().query<ManagedPerson>(
    `SELECT u.id AS "userId", u.email, p.display_name AS "displayName", p.role,
            p.organization_unit_id::text AS "organizationUnitId", o.name AS "organizationName",
            p.must_change_password AS "mustChangePassword", COALESCE(u.banned, false) AS banned,
            (g.user_id IS NOT NULL AND g.revoked_at IS NULL) AS "canManageAccounts",
            g.organization_unit_id::text AS "grantOrganizationUnitId",
            COALESCE(g.include_descendants, false) AS "includeDescendants"
       FROM app.user_profiles p
       JOIN public."user" u ON u.id = p.user_id
       LEFT JOIN app.organization_units o ON o.id = p.organization_unit_id
       LEFT JOIN app.account_management_grants g ON g.user_id = p.user_id
      WHERE true ${scope}
      ORDER BY p.created_at DESC`,
    params,
  );
  return result.rows;
}

export async function listAccountAuditEvents(limit = 30): Promise<AccountAuditEvent[]> {
  const result = await getDatabasePool().query<AccountAuditEvent>(
    `SELECT e.id::text, actor.display_name AS "actorName", target.display_name AS "targetName",
            e.action, o.name AS "organizationName", e.created_at::text AS "createdAt"
       FROM app.account_audit_events e
       JOIN app.user_profiles actor ON actor.user_id = e.actor_user_id
       LEFT JOIN app.user_profiles target ON target.user_id = e.target_user_id
       LEFT JOIN app.organization_units o ON o.id = e.organization_unit_id
      ORDER BY e.created_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(100, limit))],
  );
  return result.rows;
}

async function organizationInScope(
  actor: AuthenticatedActor,
  organizationUnitId: string,
): Promise<boolean> {
  const access = await getAccountManagementAccess(actor);
  if (!access) return false;
  if (access.kind === 'admin') return true;
  if (!access.includeDescendants) return access.organizationUnitId === organizationUnitId;
  const result = await getDatabasePool().query(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM app.organization_units WHERE id = $1 AND disabled_at IS NULL
       UNION ALL
       SELECT child.id FROM app.organization_units child JOIN descendants parent ON child.parent_id = parent.id
        WHERE child.disabled_at IS NULL
     ) SELECT 1 FROM descendants WHERE id = $2`,
    [access.organizationUnitId, organizationUnitId],
  );
  return result.rowCount === 1;
}

async function requireActiveOrganization(organizationUnitId: string) {
  const result = await getDatabasePool().query(
    `SELECT 1 FROM app.organization_units WHERE id = $1 AND disabled_at IS NULL`,
    [organizationUnitId],
  );
  if (!result.rowCount) throw new Error('InvalidOrganization');
}

export async function requireManagedLearner(actor: AuthenticatedActor, userId: string) {
  const result = await getDatabasePool().query<{ organizationUnitId: string | null }>(
    `SELECT organization_unit_id::text AS "organizationUnitId"
       FROM app.user_profiles WHERE user_id = $1 AND role = 'learner'`,
    [userId],
  );
  const learner = result.rows[0];
  if (
    !learner?.organizationUnitId ||
    !(await organizationInScope(actor, learner.organizationUnitId))
  ) {
    throw new Error('NotFound');
  }
  return learner;
}

export async function updateManagedPerson(
  actor: AuthenticatedActor,
  userId: string,
  input: { displayName: string; email: string; organizationUnitId: string | null },
) {
  const person = await getDatabasePool().query<{
    role: 'admin' | 'teacher' | 'learner';
    organizationUnitId: string | null;
  }>(
    `SELECT role, organization_unit_id::text AS "organizationUnitId"
       FROM app.user_profiles WHERE user_id = $1`,
    [userId],
  );
  const target = person.rows[0];
  if (!target) throw new Error('NotFound');
  if (actor.role !== 'admin') {
    await requireManagedLearner(actor, userId);
    if (
      !input.organizationUnitId ||
      !(await organizationInScope(actor, input.organizationUnitId))
    ) {
      throw new Error('Forbidden');
    }
  } else if (input.organizationUnitId) {
    await requireActiveOrganization(input.organizationUnitId);
  }

  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE public."user" SET name = $2, email = $3, "updatedAt" = now() WHERE id = $1`,
      [userId, input.displayName, input.email],
    );
    await client.query(
      `UPDATE app.user_profiles
          SET display_name = $2, organization_unit_id = $3, updated_at = now()
        WHERE user_id = $1`,
      [userId, input.displayName, input.organizationUnitId],
    );
    await client.query(
      `INSERT INTO app.account_audit_events
         (actor_user_id, target_user_id, action, organization_unit_id, metadata)
       VALUES ($1, $2, 'person.updated', $3, $4::jsonb)`,
      [
        actor.userId,
        userId,
        input.organizationUnitId,
        JSON.stringify({ email: input.email, displayName: input.displayName }),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function resetManagedPersonPassword(
  actor: AuthenticatedActor,
  userId: string,
  password: string,
  headers: Headers,
) {
  let organizationUnitId: string | null = null;
  if (actor.role === 'admin') {
    const person = await getDatabasePool().query<{ organizationUnitId: string | null }>(
      `SELECT organization_unit_id::text AS "organizationUnitId"
         FROM app.user_profiles WHERE user_id = $1`,
      [userId],
    );
    if (!person.rows[0]) throw new Error('NotFound');
    organizationUnitId = person.rows[0].organizationUnitId;
  } else {
    organizationUnitId = (await requireManagedLearner(actor, userId)).organizationUnitId;
  }
  await getAuth().api.setUserPassword({ body: { userId, newPassword: password }, headers });
  await getDatabasePool().query(
    `UPDATE app.user_profiles SET must_change_password = true, updated_at = now() WHERE user_id = $1`,
    [userId],
  );
  await audit(actor.userId, userId, 'person.password_reset', organizationUnitId);
}

export async function createManagedLearner(
  actor: AuthenticatedActor,
  input: { email: string; displayName: string; organizationUnitId: string; password: string },
) {
  if (!(await organizationInScope(actor, input.organizationUnitId))) throw new Error('Forbidden');
  const auth = getAuth();
  const created = await auth.api.createUser({
    body: { email: input.email, name: input.displayName, password: input.password, role: 'user' },
  });
  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO app.user_profiles
         (user_id, role, display_name, organization_unit_id, must_change_password)
       VALUES ($1, 'learner', $2, $3, true)`,
      [created.user.id, input.displayName, input.organizationUnitId],
    );
    await client.query(
      `INSERT INTO app.account_audit_events
         (actor_user_id, target_user_id, action, organization_unit_id, metadata)
       VALUES ($1, $2, 'learner.created', $3, $4::jsonb)`,
      [
        actor.userId,
        created.user.id,
        input.organizationUnitId,
        JSON.stringify({ email: input.email }),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    await auth.api.removeUser({ body: { userId: created.user.id } });
    throw error;
  } finally {
    client.release();
  }
  return created.user;
}

export async function setManagedLearnerDisabled(
  actor: AuthenticatedActor,
  userId: string,
  disabled: boolean,
) {
  const learner = await requireManagedLearner(actor, userId);
  if (disabled) await getAuth().api.banUser({ body: { userId } });
  else await getAuth().api.unbanUser({ body: { userId } });
  await audit(
    actor.userId,
    userId,
    disabled ? 'learner.disabled' : 'learner.enabled',
    learner.organizationUnitId,
  );
}

export async function resetManagedLearnerPassword(
  actor: AuthenticatedActor,
  userId: string,
  password: string,
  headers: Headers,
) {
  const learner = await requireManagedLearner(actor, userId);
  await getAuth().api.setUserPassword({ body: { userId, newPassword: password }, headers });
  await getDatabasePool().query(
    `UPDATE app.user_profiles SET must_change_password = true, updated_at = now() WHERE user_id = $1`,
    [userId],
  );
  await audit(actor.userId, userId, 'learner.password_reset', learner.organizationUnitId);
}

export async function audit(
  actorUserId: string,
  targetUserId: string | null,
  action: string,
  organizationUnitId: string | null,
  metadata: Record<string, unknown> = {},
) {
  await getDatabasePool().query(
    `INSERT INTO app.account_audit_events
       (actor_user_id, target_user_id, action, organization_unit_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [actorUserId, targetUserId, action, organizationUnitId, JSON.stringify(metadata)],
  );
}
