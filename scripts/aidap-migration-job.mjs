#!/usr/bin/env node
/**
 * A non-interactive, target-only Supabase -> AIDAP migration job.
 *
 * Secrets are supplied by Dokploy environment variables, never prompts/stdin.
 * Default mode is preflight. Full mode is deliberately blocked unless the
 * target is an AIDAP endpoint and MIGRATION_CONFIRM is set exactly.
 */

import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';

const MODE = process.env.MIGRATION_MODE || 'preflight';
const confirm = process.env.MIGRATION_CONFIRM;
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;
const sourceApiUrl = process.env.SOURCE_SUPABASE_URL;
const targetApiUrl = process.env.TARGET_SUPABASE_URL;
const targetServiceKey = process.env.TARGET_SUPABASE_SERVICE_ROLE_KEY;

const coreTables = [
  'profiles', 'students', 'courses', 'course_assignments', 'course_progress_events',
  'learning_tasks', 'task_courses', 'task_learners', 'task_course_progress',
  'task_learning_events', 'course_snapshots', 'course_revoice_jobs',
  'ai_learning_summaries', 'ai_intervention_suggestions',
];

function fail(message) {
  console.error(`MIGRATION STOPPED: ${message}`);
  process.exit(1);
}

function redactedEndpoint(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

function required(...names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) fail(`Missing Dokploy secret variable(s): ${missing.join(', ')}`);
}

async function withClient(url, action) {
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.end();
  }
}

async function inspect(url) {
  return withClient(url, async (client) => {
    const [{ rows: identity }, { rows: schemas }, { rows: tables }, { rows: users }, { rows: objects }] = await Promise.all([
      client.query('select current_user, current_database(), version()'),
      client.query("select nspname from pg_namespace where nspname in ('public', 'auth', 'storage') order by nspname"),
      client.query("select table_schema, table_name from information_schema.tables where table_type = 'BASE TABLE' and table_schema in ('public', 'auth', 'storage') order by table_schema, table_name"),
      client.query('select count(*)::int as count from auth.users'),
      client.query('select count(*)::int as count from storage.objects'),
    ]);
    return { identity: identity[0], schemas: schemas.map((row) => row.nspname), tables, users: users[0].count, objects: objects[0].count };
  });
}

async function tableCounts(url) {
  return withClient(url, async (client) => {
    const present = await client.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'");
    const names = new Set(present.rows.map((row) => row.table_name));
    const result = {};
    for (const table of coreTables) {
      result[table] = names.has(table)
        ? Number((await client.query(`select count(*)::int as count from public.${table}`)).rows[0].count)
        : null;
    }
    return result;
  });
}

async function ensureSafeTarget() {
  required('SOURCE_DATABASE_URL', 'TARGET_DATABASE_URL');
  if (!new URL(sourceUrl).hostname.endsWith('.supabase.co')) fail('SOURCE_DATABASE_URL is not a Supabase endpoint.');
  if (!new URL(targetUrl).hostname.includes('.aidap-global.')) fail('TARGET_DATABASE_URL is not an AIDAP endpoint.');
  if (MODE !== 'preflight' && confirm !== 'AIDAP_TEST_TARGET_ONLY') {
    fail('Set MIGRATION_CONFIRM=AIDAP_TEST_TARGET_ONLY before a target write.');
  }
}

async function preflight() {
  await ensureSafeTarget();
  const [source, target, sourceCounts] = await Promise.all([inspect(sourceUrl), inspect(targetUrl), tableCounts(sourceUrl)]);
  const sourceSchemasOk = ['public', 'auth', 'storage'].every((schema) => source.schemas.includes(schema));
  const targetSchemasOk = ['public', 'auth', 'storage'].every((schema) => target.schemas.includes(schema));
  if (!sourceSchemasOk || !targetSchemasOk) fail('Both endpoints must contain public, auth, and storage schemas.');
  console.log(JSON.stringify({
    mode: MODE,
    source: { endpoint: redactedEndpoint(sourceUrl), userCount: source.users, objectCount: source.objects, tableCounts: sourceCounts },
    target: { endpoint: redactedEndpoint(targetUrl), userCount: target.users, objectCount: target.objects },
    result: 'preflight-ok',
  }, null, 2));
}

async function main() {
  if (MODE !== 'preflight') {
    fail(`Mode '${MODE}' is intentionally disabled until the reviewed data-copy implementation is added. Run only MIGRATION_MODE=preflight.`);
  }
  await preflight();
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
