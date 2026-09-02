import type { Pool } from 'pg';
import type { AppRole } from './access-repository';

export interface PersonRecord {
  userId: string;
  email: string;
  displayName: string;
  role: AppRole;
  employeeNo: string | null;
  department: string | null;
  mustChangePassword: boolean;
  banned: boolean;
}

export class PeopleRepository {
  constructor(private readonly pool: Pool) {}

  async createProfile(input: {
    userId: string;
    role: AppRole;
    displayName: string;
    employeeNo?: string | null;
    department?: string | null;
    mustChangePassword?: boolean;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO app.user_profiles
        (user_id, role, display_name, employee_no, department, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.userId,
        input.role,
        input.displayName,
        input.employeeNo ?? null,
        input.department ?? null,
        input.mustChangePassword ?? true,
      ],
    );
  }

  async listPeople(): Promise<PersonRecord[]> {
    const result = await this.pool.query<PersonRecord>(
      `SELECT
         u.id AS "userId",
         u.email,
         p.display_name AS "displayName",
         p.role,
         p.employee_no AS "employeeNo",
         p.department,
         p.must_change_password AS "mustChangePassword",
         COALESCE(u.banned, false) AS banned
       FROM app.user_profiles p
       JOIN public."user" u ON u.id = p.user_id
       ORDER BY p.created_at, u.id`,
    );
    return result.rows;
  }

  async getPerson(userId: string): Promise<PersonRecord | null> {
    const result = await this.pool.query<PersonRecord>(
      `SELECT
         u.id AS "userId", u.email, p.display_name AS "displayName", p.role,
         p.employee_no AS "employeeNo", p.department,
         p.must_change_password AS "mustChangePassword",
         COALESCE(u.banned, false) AS banned
       FROM app.user_profiles p
       JOIN public."user" u ON u.id = p.user_id
       WHERE p.user_id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async setMustChangePassword(userId: string, value: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE app.user_profiles
       SET must_change_password = $2, updated_at = now()
       WHERE user_id = $1`,
      [userId, value],
    );
  }

  async updateProfile(
    userId: string,
    input: {
      role: AppRole;
      displayName: string;
      employeeNo?: string | null;
      department?: string | null;
      mustChangePassword?: boolean;
    },
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE app.user_profiles
       SET role = $2, display_name = $3, employee_no = $4, department = $5,
           must_change_password = COALESCE($6, must_change_password), updated_at = now()
       WHERE user_id = $1`,
      [
        userId,
        input.role,
        input.displayName,
        input.employeeNo ?? null,
        input.department ?? null,
        input.mustChangePassword ?? null,
      ],
    );
    return result.rowCount === 1;
  }
}
