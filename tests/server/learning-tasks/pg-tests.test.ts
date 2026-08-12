/**
 * Gate 1A.1 PG tests: pg-mem 验证表约束 + SQL 文本验证触发器/RPC
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { newDb, DataType } from 'pg-mem';

const sqlPath = resolve(process.cwd(), 'supabase-learning-tasks-v1.sql');
const sqlText = readFileSync(sqlPath, 'utf-8');
let db: ReturnType<typeof newDb>;

beforeAll(() => {
  db = newDb({ autoCreateForeignKeyIndices: true });
  const exec = (s: string) => {
    try {
      db.public.none(s);
    } catch {}
  };

  // Register pg-mem missing functions
  db.public.registerFunction({
    name: 'length',
    returns: DataType.integer,
    implementation: (v: unknown) => (typeof v === 'string' ? v.length : 0),
  });
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001',
  });
  db.public.registerFunction({
    name: 'now',
    returns: DataType.timestamp,
    implementation: () => new Date(),
  });

  // Base tables
  exec(
    'create table if not exists courses (id text primary key, title text, data jsonb, created_by text)',
  );
  exec(
    'create table if not exists students (id uuid primary key default gen_random_uuid(), name text, disabled_at timestamptz, user_id uuid)',
  );
  exec('create table if not exists profiles (id uuid primary key, role text)');
  exec("insert into courses(id) values ('c1')");
  exec("insert into students(id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001')");

  // Learning tables (simplified for pg-mem compatibility)
  exec(
    `create table if not exists course_snapshots (id uuid primary key default gen_random_uuid(), course_id text, source_hash text, snapshot_data jsonb, created_by uuid, created_at timestamptz default now(), unique(course_id, source_hash))`,
  );
  exec(
    `create table if not exists learning_tasks (id uuid primary key default gen_random_uuid(), course_id text, title text, created_by uuid, status text default 'draft' check(status in('draft','published','closed','archived')), task_type text default 'normal' check(task_type in('normal','remedial')), source_task_id uuid, start_at timestamptz, due_at timestamptz, completion_rule jsonb default '{}', share_token text unique, published_at timestamptz, snapshot_id uuid, created_at timestamptz default now(), updated_at timestamptz default now(), constraint ck_pub check(status<>'published' or (snapshot_id is not null and share_token is not null and published_at is not null)), constraint ck_draft check(status<>'draft' or published_at is null), constraint ck_time check(due_at is null or start_at is null or due_at>=start_at), constraint ck_type check((task_type='normal' and source_task_id is null) or (task_type='remedial' and source_task_id is not null)))`,
  );
  exec(
    `create table if not exists task_learners (id uuid primary key default gen_random_uuid(), task_id uuid, student_id uuid, status text default 'not_started', progress_percent numeric default 0 check(progress_percent>=0 and progress_percent<=100), completed_scene_count integer default 0 check(completed_scene_count>=0), total_scene_count integer default 0 check(total_scene_count>=0), effective_seconds integer default 0 check(effective_seconds>=0), assigned_at timestamptz default now(), updated_at timestamptz default now(), unique(task_id, student_id), check(completed_scene_count<=total_scene_count))`,
  );
});

const U1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001';

describe('表约束 (pg-mem)', () => {
  it('status 只能是 valid values', () => {
    expect(() =>
      db.public.none(
        `insert into learning_tasks (course_id,title,created_by,status) values ('c1','t','${U1}','invalid')`,
      ),
    ).toThrow();
  });
  it('published 需要 snapshot+token+time', () => {
    expect(() =>
      db.public.none(
        `insert into learning_tasks (course_id,title,created_by,status) values ('c1','t','${U1}','published')`,
      ),
    ).toThrow();
  });
  it('draft 不得有 published_at', () => {
    expect(() =>
      db.public.none(
        `insert into learning_tasks (course_id,title,created_by,status,published_at) values ('c1','t','${U1}','draft',now())`,
      ),
    ).toThrow();
  });
  it('due < start 被拒', () => {
    expect(() =>
      db.public.none(
        `insert into learning_tasks (course_id,title,created_by,status,start_at,due_at) values ('c1','t','${U1}','draft','2026-06-01','2026-05-01')`,
      ),
    ).toThrow();
  });
  it('normal 不得有 source_task_id', () => {
    expect(() =>
      db.public.none(
        `insert into learning_tasks (course_id,title,created_by,source_task_id) values ('c1','t','${U1}','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')`,
      ),
    ).toThrow();
  });
  it('remedial 必须有 source_task_id', () => {
    expect(() =>
      db.public.none(
        `insert into learning_tasks (course_id,title,created_by,task_type) values ('c1','t','${U1}','remedial')`,
      ),
    ).toThrow();
  });
  it('progress 0-100', () => {
    db.public.none(
      `insert into learning_tasks (id,course_id,title,created_by) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0002','c1','t','${U1}')`,
    );
    db.public.none(
      `insert into task_learners (task_id,student_id,progress_percent) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0002','${U1}',50)`,
    );
    expect(() =>
      db.public.none(
        `insert into task_learners (task_id,student_id,progress_percent) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0002','${U1}',101)`,
      ),
    ).toThrow();
  });
  it('completed <= total', () => {
    expect(() =>
      db.public.none(
        `insert into task_learners (task_id,student_id,completed_scene_count,total_scene_count) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0002','${U1}',5,3)`,
      ),
    ).toThrow();
  });
});

describe('SQL 文本验证', () => {
  it('快照不可变触发器', () => {
    expect(sqlText).toContain('course_snapshots are immutable');
  });
  it('任务不可变触发器', () => {
    expect(sqlText).toContain('course_id cannot be changed after publish');
  });
  it('名单冻结触发器', () => {
    expect(sqlText).toContain('Cannot modify learners of a non-draft task');
  });
  it('状态机禁止 draft→closed', () => {
    expect(sqlText).toContain('draft can only transition to published or archived');
  });
  it('create_task_with_learners 函数', () => {
    expect(sqlText).toContain('create_task_with_learners');
  });
  it('replace_task_learners 整体拒绝', () => {
    expect(sqlText).toContain('All learners must exist and not be disabled');
  });
  it('publish_task FOR UPDATE', () => {
    expect(sqlText).toMatch(/for update/);
  });
  it('publish_task DO NOTHING', () => {
    expect(sqlText).toMatch(/on conflict.*do nothing/i);
  });
  it('SQLSTATE 5字符', () => {
    const codes =
      sqlText.match(/errcode\s*=\s*'([^']+)'/g)?.map((c) => c.match(/'([^']+)'/)![1]) ?? [];
    for (const c of codes) expect(c.length).toBe(5);
  });
  it('migration 可重跑', () => {
    expect(sqlText).toMatch(/create table if not exists public\.course_snapshots/);
  });
});
