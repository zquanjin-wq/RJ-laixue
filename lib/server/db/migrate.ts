import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrateDatabase(
  pool: Pool,
  migrationsDir = resolve(process.cwd(), 'db', 'migrations'),
): Promise<MigrationResult> {
  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const existing = await pool.query<{ name: string }>('SELECT name FROM public.schema_migrations');
  const appliedNames = new Set(existing.rows.map((row) => row.name));
  const result: MigrationResult = { applied: [], skipped: [] };

  for (const name of files) {
    if (appliedNames.has(name)) {
      result.skipped.push(name);
      continue;
    }

    const sql = await readFile(resolve(migrationsDir, name), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO public.schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      result.applied.push(name);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return result;
}
