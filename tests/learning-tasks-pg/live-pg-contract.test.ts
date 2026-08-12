/**
 * Gate 1A.1 live PG E2E tests
 * 运行：LEARNING_LIVE_PG_EMBED=1 vitest run tests/learning-tasks-pg/live-pg-contract.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFile, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { cp, rm } from 'fs/promises';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { promisify } from 'util';
import { Pool } from 'pg';
import { createHash } from 'crypto';

const EMBED = process.env.LEARNING_LIVE_PG_EMBED === '1';
const RUN = EMBED ? describe : describe.skip;

let adminPool: Pool;
let anonPool: Pool;
let authenticatedPool: Pool;
let pgBinDir: string | undefined;
let pgDataDir: string | undefined;

const ROLES = {
  anon: { user: 'anon_role', pass: 'anon', role: 'anon' },
  auth: { user: 'auth_role', pass: 'auth', role: 'authenticated' },
  svc: { user: 'svc_role', pass: 'svc', role: 'service_role' },
};

async function bootstrapEmbeddedPg(): Promise<string> {
  const req = createRequire(import.meta.url);
  const epMain = req.resolve('embedded-postgres');
  const binSrc = join(dirname(epMain), '..', '..', '@embedded-postgres', 'windows-x64', 'native');
  const binDst = join(tmpdir(), 'rj-pg-bin-learn');
  if (!existsSync(join(binDst, 'bin', 'postgres.exe'))) {
    await rm(binDst, { recursive: true, force: true });
    await cp(binSrc, binDst, { recursive: true });
  }
  pgBinDir = binDst;
  pgDataDir = join(tmpdir(), 'rj-live-pg-learn');
  await rm(pgDataDir, { recursive: true, force: true });
  await promisify(execFile)(join(binDst, 'bin', 'initdb.exe'), [
    '-D',
    pgDataDir,
    '-U',
    'postgres',
    '--no-locale',
    '-E',
    'UTF8',
    '-A',
    'trust',
  ]);
  writeFileSync(
    join(pgDataDir, 'pg_hba.conf'),
    'host all all 127.0.0.1/32 trust\nlocal all all trust\n',
  );
  const child = spawn(
    join(binDst, 'bin', 'postgres.exe'),
    ['-D', pgDataDir, '-p', '55434', '-h', '127.0.0.1'],
    { stdio: 'ignore' },
  );
  child.on('error', () => {});
  const url = 'postgres://postgres@localhost:55434/postgres';
  for (let i = 0; i < 120; i++) {
    try {
      const probe = new Pool({ connectionString: url, max: 1 });
      await probe.query('select 1');
      await probe.end();
      return url;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('embedded postgres did not become ready');
}

const HASH = (() => {
  function sortKeys(v: unknown): unknown {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return (v as unknown[]).map(sortKeys);
    const obj = v as Record<string, unknown>;
    const s: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) s[k] = sortKeys(obj[k]);
    return s;
  }
  return createHash('sha256')
    .update(
      JSON.stringify(
        sortKeys({
          stage: { id: 's1', name: 'Stage' },
          scenes: [{ id: 'sc1', title: 'Scene 1' }],
          outlines: [],
        }),
      ),
    )
    .digest('hex');
})();

beforeAll(async () => {
  if (!EMBED) return;
  const url = await bootstrapEmbeddedPg();

  // admin connection for schema setup
  adminPool = new Pool({ connectionString: url, max: 4 });

  // Extension installed into a dedicated schema for deterministic resolution
  await adminPool.query('create schema if not exists extensions');
  await adminPool.query('create extension if not exists pgcrypto with schema extensions');

  // Supabase NOLOGIN base roles
  const baseRoles = ['anon', 'authenticated', 'service_role'];
  for (const r of baseRoles) {
    await adminPool.query(
      `do $$ begin create role "${r}" with nologin; exception when duplicate_object then null; end; $$`,
    );
  }

  // Login test roles that inherit from base roles
  for (const r of Object.values(ROLES)) {
    await adminPool.query(
      `do $$ begin create role "${r.user}" with login password '${r.pass}'; exception when duplicate_object then null; end; $$`,
    );
  }
  await adminPool.query('grant anon to "anon_role"');
  await adminPool.query('grant authenticated to "auth_role"');
  await adminPool.query('grant service_role to "svc_role"');

  // auth schema
  await adminPool.query('create schema if not exists auth');
  await adminPool.query(`
    create table if not exists auth.users (
      id uuid primary key default gen_random_uuid(),
      email text, created_at timestamptz default now()
    );
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
  `);
  await adminPool.query(`insert into auth.users(id, email) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001','t@t.com'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0002','a@t.com'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0003','l@t.com') on conflict do nothing`);

  // base tables
  await adminPool.query(`
    create table if not exists public.courses (id text primary key, title text, data jsonb, created_by uuid, created_at timestamptz default now(), updated_at timestamptz default now());
    create table if not exists public.students (id uuid primary key default gen_random_uuid(), name text, access_code text, email text, employee_no text, note text, disabled_at timestamptz, user_id uuid, created_at timestamptz default now(), updated_at timestamptz default now());
    create table if not exists public.profiles (id uuid primary key references auth.users(id), role text);
    insert into public.courses(id, title, data, created_by) values ('c1','Test','{"stage":{"id":"s1","name":"Stage"},"scenes":[{"id":"sc1","title":"Scene 1"}]}','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001') on conflict do nothing;
    insert into public.students(id, name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0009','S1'),('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0010','S2'),('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0011','S3') on conflict do nothing;
    insert into public.profiles(id, role) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001','teacher'),('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0002','admin'),('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0003','learner') on conflict do nothing;
  `);

  // Run migration via pg driver (handles multi-statement natively, no splitting needed)
  const sql = readFileSync(resolve(process.cwd(), 'supabase-learning-tasks-v1.sql'), 'utf-8');
  await adminPool.query(sql); // first run — any error fails beforeAll
  await adminPool.query(sql); // second run — verify idempotent
  const gate1cSql = readFileSync(
    resolve(process.cwd(), 'supabase-learning-tasks-gate1c.sql'),
    'utf-8',
  );
  await adminPool.query(gate1cSql);
  await adminPool.query(gate1cSql);
  const gate1eSql = readFileSync(
    resolve(process.cwd(), 'supabase-learning-tasks-gate1e.sql'),
    'utf-8',
  );
  await adminPool.query(gate1eSql);
  await adminPool.query(gate1eSql);

  // Role-specific connection pools for RLS tests (do not reuse the postgres URL)
  anonPool = new Pool({
    connectionString: `postgres://${ROLES.anon.user}:${ROLES.anon.pass}@localhost:55434/postgres`,
    max: 2,
  });
  authenticatedPool = new Pool({
    connectionString: `postgres://${ROLES.auth.user}:${ROLES.auth.pass}@localhost:55434/postgres`,
    max: 2,
  });

  // Sanity check: role pools are actually connected as the intended users
  const { rows: anonUser } = await anonPool.query('select current_user');
  expect(anonUser[0].current_user).toBe(ROLES.anon.user);
  const { rows: authUser } = await authenticatedPool.query('select current_user');
  expect(authUser[0].current_user).toBe(ROLES.auth.user);
}, 600_000);

afterAll(async () => {
  await anonPool?.end();
  await authenticatedPool?.end();
  await adminPool?.end();
  if (pgBinDir && pgDataDir) {
    try {
      await promisify(execFile)(join(pgBinDir, 'bin', 'pg_ctl.exe'), [
        'stop',
        '-D',
        pgDataDir,
        '-m',
        'fast',
        '-w',
        '-t',
        '30',
      ]);
    } catch {}
  }
});

RUN('live PG learning-tasks E2E', () => {
  test('1. 三张表存在', async () => {
    const { rows } = await adminPool.query(
      `select tablename from pg_tables where schemaname='public' and tablename in ('course_snapshots','learning_tasks','task_learners') order by tablename`,
    );
    expect(rows).toHaveLength(3);
  });

  test('2. RLS 启用', async () => {
    const { rows } = await adminPool.query(
      `select tablename,rowsecurity from pg_tables where schemaname='public' and tablename in ('course_snapshots','learning_tasks','task_learners')`,
    );
    for (const r of rows) expect(r.rowsecurity).toBe(true);
  });

  test('3. anon 不能写入 learning_tasks', async () => {
    await expect(
      anonPool.query(
        `insert into public.learning_tasks(course_id,title,created_by) values ('c1','t','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  test('4. draft → published 合法', async () => {
    const { rows: r } = await adminPool.query(
      `select * from create_task_with_learners('c1','T4','','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001','normal',null,'2026-06-01','2026-07-01','{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0009}') as v`,
    );
    const tid = (r[0].v as Record<string, unknown>).task_id;
    const { rows: rpc } = await adminPool.query(
      `select publish_task($1::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001'::uuid, $2::text) as v`,
      [tid, HASH],
    );
    expect(rpc[0].v.published).toBe(true);
  });

  test('5. draft → closed 被禁', async () => {
    // create a new draft for this test
    const { rows: rpc } = await adminPool.query(
      `select create_task_with_learners('c1','X','','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001','normal',null,null,null,'{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0009}') as v`,
    );
    const tid = (rpc[0].v as Record<string, unknown>).task_id;
    await expect(
      adminPool.query(`update public.learning_tasks set status='closed' where id=$1::uuid`, [tid]),
    ).rejects.toThrow(/draft can only/);
  });

  test('6. published 后 course_id 不可变', async () => {
    const { rows: rpc } = await adminPool.query(
      `select create_task_with_learners('c1','Y','','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001','normal',null,null,null,'{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0009}') as v`,
    );
    const tid = (rpc[0].v as Record<string, unknown>).task_id;
    await adminPool.query(
      `select publish_task($1::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001'::uuid, $2::text)`,
      [tid, HASH],
    );
    await expect(
      adminPool.query(`update public.learning_tasks set course_id='c2' where id=$1::uuid`, [tid]),
    ).rejects.toThrow(/course_id cannot be changed/);
  });

  test('7. published 后名单不可增删', async () => {
    const { rows: rpc } = await adminPool.query(
      `select create_task_with_learners('c1','Z','','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001','normal',null,null,null,'{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0009}') as v`,
    );
    const tid = (rpc[0].v as Record<string, unknown>).task_id;
    await adminPool.query(
      `select publish_task($1::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001'::uuid, $2::text)`,
      [tid, HASH],
    );
    await expect(
      adminPool.query(
        `insert into public.task_learners(task_id,student_id) values($1::uuid,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0010')`,
        [tid],
      ),
    ).rejects.toThrow(/Cannot modify/);
    await expect(
      adminPool.query(`delete from public.task_learners where task_id=$1::uuid`, [tid]),
    ).rejects.toThrow(/Cannot modify/);
  });

  test('8. replace 失败后旧名单保持', async () => {
    const { rows: rpc } = await adminPool.query(
      `select create_task_with_learners('c1','W','','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001','normal',null,null,null,'{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0009}') as v`,
    );
    const tid = (rpc[0].v as Record<string, unknown>).task_id;
    await expect(
      adminPool.query(
        `select replace_task_learners($1::uuid, '{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0099}')`,
        [tid],
      ),
    ).rejects.toThrow();
    const { rows } = await adminPool.query(
      `select student_id from public.task_learners where task_id=$1::uuid`,
      [tid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].student_id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0009');
  });

  test('9. 并发发布返回同一 token 和 snapshot', async () => {
    const { rows: rpc } = await adminPool.query(
      `select create_task_with_learners('c1','V','','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001','normal',null,null,null,'{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0009}') as v`,
    );
    const tid = (rpc[0].v as Record<string, unknown>).task_id;
    const c1 = await adminPool.connect();
    const c2 = await adminPool.connect();
    try {
      const [r1, r2] = await Promise.all([
        c1.query(
          `select publish_task($1::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001'::uuid, $2::text) as v`,
          [tid, HASH],
        ),
        c2.query(
          `select publish_task($1::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001'::uuid, $2::text) as v`,
          [tid, HASH],
        ),
      ]);
      const t1 = r1.rows[0].v as Record<string, unknown>;
      const t2 = r2.rows[0].v as Record<string, unknown>;
      expect(t1.share_token).toBe(t2.share_token);
      expect(t1.snapshot_id).toBe(t2.snapshot_id);
    } finally {
      c1.release();
      c2.release();
    }
  });

  test('10. 相同课程 hash 只产生一个 snapshot', async () => {
    const { rows } = await adminPool.query(
      `select count(*)::int as n from public.course_snapshots where course_id='c1'`,
    );
    expect(rows[0].n).toBe(1);
  });

  test('11. snapshot 不可 UPDATE/DELETE', async () => {
    const { rows } = await adminPool.query(`select id from public.course_snapshots limit 1`);
    expect(rows.length).toBeGreaterThan(0);
    await expect(
      adminPool.query(`update public.course_snapshots set source_hash='bad' where id=$1::uuid`, [
        rows[0].id,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      adminPool.query(`delete from public.course_snapshots where id=$1::uuid`, [rows[0].id]),
    ).rejects.toThrow(/immutable/);
  });

  test('12. 空名单发布被拒绝', async () => {
    const { rows: rpc } = await adminPool.query(
      `select create_task_with_learners('c1','U','','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001','normal',null,null,null,'{}') as v`,
    );
    const tid = (rpc[0].v as Record<string, unknown>).task_id;
    await expect(
      adminPool.query(
        `select publish_task($1::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001'::uuid, $2::text)`,
        [tid, HASH],
      ),
    ).rejects.toThrow();
  });

  test('13. Gate 1C event table exists with RLS', async () => {
    const { rows } = await adminPool.query(
      `select rowsecurity from pg_tables where schemaname='public' and tablename='task_learning_events'`,
    );
    expect(rows).toEqual([{ rowsecurity: true }]);
  });

  test('14. duplicate client event is rejected', async () => {
    const { rows } = await adminPool.query(
      `select create_task_with_learners('c1','Event','','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001','normal',null,null,null,'{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0009}') as v`,
    );
    const taskId = rows[0].v.task_id;
    const sql = `insert into public.task_learning_events(task_id,student_id,client_event_id,event_type)
      values ($1::uuid,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0009','same-event','task_opened')`;
    await adminPool.query(sql, [taskId]);
    await expect(adminPool.query(sql, [taskId])).rejects.toThrow();
  });

  test('15. anon cannot write task learning events', async () => {
    await expect(
      anonPool.query(
        `insert into public.task_learning_events(task_id,student_id,client_event_id,event_type)
         values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0009','anon-event','task_opened')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  test('16. Gate 1E AI tables exist with RLS', async () => {
    const { rows } = await adminPool.query(
      `select tablename, rowsecurity from pg_tables
       where schemaname='public'
         and tablename in ('ai_learning_summaries','ai_intervention_suggestions')
       order by tablename`,
    );
    expect(rows).toEqual([
      { tablename: 'ai_intervention_suggestions', rowsecurity: true },
      { tablename: 'ai_learning_summaries', rowsecurity: true },
    ]);
  });
});
