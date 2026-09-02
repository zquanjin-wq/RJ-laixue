import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import pg from 'pg';

const [email, password, name = 'laixue 管理员'] = process.argv.slice(2);
if (!email || !password) {
  throw new Error('用法：node scripts/bootstrap-admin.mjs <email> <password> [name]');
}
if (!process.env.BETTER_AUTH_SECRET) {
  throw new Error('BETTER_AUTH_SECRET is required');
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const existing = await pool.query("SELECT 1 FROM app.user_profiles WHERE role = 'admin' LIMIT 1");
  if (existing.rowCount) throw new Error('管理员已经存在，初始化命令不再执行');

  const auth = betterAuth({
    appName: 'laixue',
    baseURL: process.env.BETTER_AUTH_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    database: pool,
    emailAndPassword: { enabled: true },
    plugins: [admin()],
  });
  const created = await auth.api.createUser({ body: { email, password, name, role: 'admin' } });
  await pool.query(
    `INSERT INTO app.user_profiles (user_id, role, display_name, must_change_password)
     VALUES ($1, 'admin', $2, false)`,
    [created.user.id, name],
  );
  console.log(`管理员已创建：${email}`);
} finally {
  await pool.end();
}
