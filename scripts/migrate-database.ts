import { migrateDatabase } from '../lib/server/db/migrate';
import { getDatabasePool } from '../lib/server/db/pool';

const pool = getDatabasePool();

try {
  const result = await migrateDatabase(pool);
  console.log(`数据库迁移完成：新增 ${result.applied.length}，已存在 ${result.skipped.length}`);
  for (const name of result.applied) console.log(`+ ${name}`);
} finally {
  await pool.end();
}
