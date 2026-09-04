import { randomBytes } from 'node:crypto';
import { getAuth } from '@/lib/server/auth';
import { requireRole } from '@/lib/server/auth-context';
import { getDatabasePool } from '@/lib/server/db/pool';

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

export function generateInitialPassword(length = 12): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]).join('');
}

export async function requireAdmin() {
  return requireRole(['admin']);
}

export async function listTeachers() {
  const result = await getDatabasePool().query<{
    id: string;
    display_name: string;
    email: string;
    disabled_at: boolean;
    created_at: string;
  }>(
    `SELECT u.id, p.display_name, u.email, COALESCE(u.banned, false) AS disabled_at, p.created_at
     FROM app.user_profiles p
     JOIN public."user" u ON u.id = p.user_id
     WHERE p.role = 'teacher'
     ORDER BY p.created_at DESC`,
  );
  return result.rows;
}

export async function getTeacher(userId: string) {
  const result = await getDatabasePool().query<{ id: string }>(
    `SELECT u.id FROM app.user_profiles p JOIN public."user" u ON u.id = p.user_id
     WHERE p.user_id = $1 AND p.role = 'teacher'`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function createTeacher(input: { email: string; name: string; password: string }) {
  const created = await getAuth().api.createUser({ body: { email: input.email, name: input.name, password: input.password } });
  await getDatabasePool().query(
    `INSERT INTO app.user_profiles (user_id, role, display_name, must_change_password)
     VALUES ($1, 'teacher', $2, true)`,
    [created.user.id, input.name],
  );
  return created.user;
}

export async function setTeacherDisabled(userId: string, disabled: boolean) {
  const result = await getDatabasePool().query(
    `UPDATE public."user" u SET banned = $2, "updatedAt" = now()
     FROM app.user_profiles p WHERE u.id = p.user_id AND u.id = $1 AND p.role = 'teacher'`,
    [userId, disabled],
  );
  return result.rowCount === 1;
}
