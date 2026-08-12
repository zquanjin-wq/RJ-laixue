/**
 * Gate 1A.1: SQL 迁移文件结构测试
 * 验证：幂等性（可重跑）、RLS 最小化、表结构、触发器、RPC 存在
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sqlPath = resolve(process.cwd(), 'supabase-learning-tasks-v1.sql');
const sql = readFileSync(sqlPath, 'utf-8');

describe('migration 幂等性', () => {
  it('表使用 create table if not exists', () => {
    expect(sql).toMatch(/create table if not exists public\.course_snapshots/);
    expect(sql).toMatch(/create table if not exists public\.learning_tasks/);
    expect(sql).toMatch(/create table if not exists public\.task_learners/);
  });

  it('每个 create policy 前有 drop policy if exists', () => {
    const creates = sql.match(/create policy "/g);
    const drops = sql.match(/drop policy if exists "/g);
    expect(creates?.length).toBeGreaterThan(0);
    expect(drops?.length).toBeGreaterThanOrEqual(creates?.length ?? 0);
  });

  it('索引使用 create index if not exists', () => {
    expect(sql).toMatch(/create index if not exists learning_tasks_created_by_idx/);
    expect(sql).toMatch(/create index if not exists task_learners_student_task_idx/);
  });
});

describe('RLS 最小化', () => {
  it('撤销 anon 一切权限', () => {
    expect(sql).toMatch(/revoke all on public\.course_snapshots from anon/);
  });

  it('撤销 authenticated 写权限', () => {
    expect(sql).toMatch(
      /revoke insert, update, delete on public\.learning_tasks from authenticated/,
    );
  });

  it('snapshot 无浏览器策略', () => {
    // snapshot 不创建任何 read policy（不暴露给浏览器）
    const snapshotPolicies = sql.match(/create policy.*on public\.course_snapshots/g);
    expect(snapshotPolicies).toBeNull();
  });

  it('learning_tasks 只允许学员读自己的已发布任务', () => {
    expect(sql).toMatch(/status = 'published'/);
    expect(sql).toMatch(/s\.user_id = auth\.uid\(\)/);
  });
});

describe('不可变性与状态机', () => {
  it('course_snapshots 有不可修改触发器', () => {
    expect(sql).toMatch(/prevent_snapshot_modification/);
    expect(sql).toMatch(/course_snapshots are immutable/);
  });

  it('learning_tasks 有不可变触发器', () => {
    expect(sql).toMatch(/check_learning_tasks_immutability/);
    expect(sql).toMatch(/course_id cannot be changed after publish/);
  });

  it('task_learners 有名单冻结触发器', () => {
    expect(sql).toMatch(/check_task_learners_frozen/);
    expect(sql).toMatch(/Cannot modify learners of a non-draft task/);
  });
});

describe('RPC 存在', () => {
  it('create_task_with_learners 以 security definer 定义', () => {
    expect(sql).toMatch(/create or replace function.*create_task_with_learners/);
    expect(sql).toMatch(/security definer/);
    expect(sql).toMatch(/revoke execute.*create_task_with_learners/);
  });

  it('replace_task_learners 以 security definer 定义', () => {
    expect(sql).toMatch(/create or replace function.*replace_task_learners/);
    expect(sql).toMatch(/delete from public\.task_learners/);
    expect(sql).toMatch(/insert into public\.task_learners/);
  });

  it('publish_task 以 for update 行锁实现并发安全', () => {
    expect(sql).toMatch(/create or replace function.*publish_task/);
    expect(sql).toMatch(/for update/);
    expect(sql).toMatch(/status = 'draft'/);
    // 并发失败时读回数据库最终结果
    expect(sql).toMatch(/recheck|not found/);
  });
});

describe('约束', () => {
  it('completed_scene_count 非负', () => {
    expect(sql).toMatch(/completed_scene_count >= 0/);
  });

  it('progress_percent 0-100', () => {
    expect(sql).toMatch(/progress_percent >= 0 and progress_percent <= 100/);
  });

  it('token 长度检查', () => {
    expect(sql).toMatch(/length\(share_token\)/);
  });

  it('normal 任务无 source_task_id', () => {
    expect(sql).toMatch(/task_type = 'normal' and source_task_id is null/);
  });
});
