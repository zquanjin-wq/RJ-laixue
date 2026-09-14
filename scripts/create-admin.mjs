import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import pg from 'pg';

const [rawEmail, password, rawName] = process.argv.slice(2);
const email = rawEmail?.trim().toLowerCase();
const name = rawName?.trim() || email?.split('@')[0] || 'laixue 管理员';

if (!email || !email.includes('@') || !password) {
  throw new Error('用法：node scripts/create-admin.mjs <email> <password> [name]');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!process.env.BETTER_AUTH_SECRET) throw new Error('BETTER_AUTH_SECRET is required');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  const existing = await pool.query(
    `SELECT u.id, p.role
       FROM public."user" u
       LEFT JOIN app.user_profiles p ON p.user_id = u.id
      WHERE lower(u.email) = $1`,
    [email],
  );
  const current = existing.rows[0];
  if (current) {
    if (current.role === 'admin') {
      console.log(`管理员已存在，未做修改：${email}`);
      process.exitCode = 0;
    } else {
      throw new Error(`邮箱已被非管理员账号占用：${email}`);
    }
  } else {
    const auth = betterAuth({
      appName: 'laixue',
      baseURL: process.env.BETTER_AUTH_URL,
      secret: process.env.BETTER_AUTH_SECRET,
      database: pool,
      emailAndPassword: { enabled: true },
      plugins: [admin()],
    });
    const created = await auth.api.createUser({
      body: { email, password, name, role: 'admin' },
    });
    try {
      await pool.query(
        `INSERT INTO app.user_profiles (user_id, role, display_name, must_change_password)
         VALUES ($1, 'admin', $2, true)`,
        [created.user.id, name],
      );
    } catch (error) {
      await auth.api.removeUser({ body: { userId: created.user.id } });
      throw error;
    }
    console.log(`管理员已创建：${email}`);
  }
} finally {
  await pool.end();
}
