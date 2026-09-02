import { getAuth } from '../lib/server/auth';
import { PeopleRepository } from '../lib/server/db/people-repository';
import { getDatabasePool } from '../lib/server/db/pool';

const [email, password, name = 'laixue 管理员'] = process.argv.slice(2);
if (!email || !password) {
  throw new Error('用法：pnpm admin:bootstrap <email> <password> [name]');
}

const pool = getDatabasePool();
try {
  const existing = await pool.query(`SELECT 1 FROM app.user_profiles WHERE role = 'admin' LIMIT 1`);
  if (existing.rowCount) throw new Error('管理员已经存在，初始化命令不再执行');

  const created = await getAuth().api.createUser({
    body: { email, password, name, role: 'admin' },
  });
  await new PeopleRepository(pool).createProfile({
    userId: created.user.id,
    role: 'admin',
    displayName: name,
    mustChangePassword: false,
  });
  console.log(`管理员已创建：${email}`);
} finally {
  await pool.end();
}
