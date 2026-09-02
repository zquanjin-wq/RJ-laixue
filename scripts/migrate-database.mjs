import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const pool = new pg.Pool({ connectionString });

try {
  const migrationsDir = resolve(process.cwd(), 'db', 'migrations');
  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));

  await pool.query(
    'CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const existing = await pool.query('SELECT name FROM public.schema_migrations');
  const appliedNames = new Set(existing.rows.map((row) => row.name));

  for (const name of files) {
    if (appliedNames.has(name)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(resolve(migrationsDir, name), 'utf8'));
      await client.query('INSERT INTO public.schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log(`已应用 ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
