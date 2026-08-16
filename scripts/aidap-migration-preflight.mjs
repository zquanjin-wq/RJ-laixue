#!/usr/bin/env node
/**
 * Read-only preflight for the production Supabase -> AIDAP migration.
 *
 * Required environment variables (never commit their values):
 *   SOURCE_DATABASE_URL - direct PostgreSQL URL for the current Supabase project
 *   TARGET_DATABASE_URL - direct PostgreSQL URL for the AIDAP test branch
 *
 * This script deliberately does not export, import, delete, or alter data.
 * It proves that a dump/restore can be attempted safely in the next step.
 */

import pg from 'pg';

const { Client } = pg;

const required = ['SOURCE_DATABASE_URL', 'TARGET_DATABASE_URL'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing required migration variables: ${missing.join(', ')}`);
  console.error('Set them only in a local secure environment; do not add them to Git or Dokploy production variables.');
  process.exit(2);
}

function redactDatabaseUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return '[invalid database URL]';
  }
}

const expectedPublicTables = [
  'profiles',
  'students',
  'courses',
  'course_progress_events',
  'learning_tasks',
  'task_courses',
  'task_learners',
  'task_course_progress',
  'task_learning_events',
  'course_snapshots',
  'course_revoice_jobs',
];

async function inspect(label, connectionString) {
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const [{ rows: identity }, { rows: schemas }, { rows: tables }, { rows: extensions }] = await Promise.all([
      client.query('select current_user as current_user, current_database() as database, version() as version'),
      client.query("select nspname from pg_namespace where nspname in ('public', 'auth', 'storage') order by nspname"),
      client.query("select table_schema, table_name from information_schema.tables where table_type = 'BASE TABLE' and table_schema in ('public', 'auth', 'storage') order by table_schema, table_name"),
      client.query('select extname, extversion from pg_extension order by extname'),
    ]);

    const publicTables = new Set(tables.filter((row) => row.table_schema === 'public').map((row) => row.table_name));
    const absentExpectedTables = expectedPublicTables.filter((table) => !publicTables.has(table));

    return {
      label,
      endpoint: redactDatabaseUrl(connectionString),
      identity: identity[0],
      schemas: schemas.map((row) => row.nspname),
      tableCounts: tables.reduce((acc, row) => {
        acc[row.table_schema] = (acc[row.table_schema] || 0) + 1;
        return acc;
      }, {}),
      missingExpectedPublicTables: absentExpectedTables,
      extensions: extensions.map((row) => `${row.extname}@${row.extversion}`),
    };
  } finally {
    await client.end();
  }
}

try {
  const [source, target] = await Promise.all([
    inspect('source', process.env.SOURCE_DATABASE_URL),
    inspect('target', process.env.TARGET_DATABASE_URL),
  ]);

  console.log(JSON.stringify({ source, target }, null, 2));

  if (!source.schemas.includes('auth') || !source.schemas.includes('storage')) {
    console.error('Source lacks the expected auth/storage schemas; stop before any migration.');
    process.exitCode = 1;
  }
  if (!target.schemas.includes('auth') || !target.schemas.includes('storage')) {
    console.error('Target lacks the expected auth/storage schemas; stop before any migration.');
    process.exitCode = 1;
  }
  if (source.missingExpectedPublicTables.length) {
    console.error(`Source is missing expected public tables: ${source.missingExpectedPublicTables.join(', ')}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error('Migration preflight failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
