import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), 'supabase-learning-tasks-gate2b.sql'), 'utf8');

describe('Gate 2B task course package migration', () => {
  it('tracks per-course progress and backfills existing learners', () => {
    expect(sql).toMatch(/create table if not exists public\.task_course_progress/);
    expect(sql).toMatch(/insert into public\.task_course_progress/);
    expect(sql).toMatch(/from public\.task_learners tl join public\.task_courses/);
  });

  it('creates snapshots and course progress when a package is published', () => {
    expect(sql).toMatch(/create or replace function public\.publish_task_course_package/);
    expect(sql).toMatch(/update public\.task_courses set snapshot_id/);
    expect(sql).toMatch(/create_task_course_progress_on_assignment/);
  });
});
