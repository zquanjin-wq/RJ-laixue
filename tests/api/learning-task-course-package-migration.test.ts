import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), 'supabase-learning-tasks-gate2a.sql'), 'utf8');

describe('Gate 2A task course package migration', () => {
  it('creates an ordered task_courses package and backfills old tasks', () => {
    expect(sql).toMatch(/create table if not exists public\.task_courses/);
    expect(sql).toMatch(/unique\(task_id, course_id\)/);
    expect(sql).toMatch(/unique\(task_id, position\)/);
    expect(sql).toMatch(/insert into public\.task_courses/);
    expect(sql).toMatch(/from public\.learning_tasks/);
  });

  it('allows package editing only while a task is a draft', () => {
    expect(sql).toMatch(/check_task_courses_frozen/);
    expect(sql).toMatch(/course package cannot be changed after publish/);
    expect(sql).toMatch(/create or replace function public\.replace_task_courses/);
  });
});
