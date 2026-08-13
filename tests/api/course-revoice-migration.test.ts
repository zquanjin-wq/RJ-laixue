import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), 'supabase-course-revoice-jobs.sql'), 'utf8');

describe('course revoice database invariants', () => {
  it('allows only one active job per course', () => {
    expect(sql).toMatch(/create unique index[\s\S]*on public\.course_revoice_jobs \(course_id\)[\s\S]*where status in \('queued', 'running'\)/i);
  });

  it('commits only while the job is still running and course version matches', () => {
    expect(sql).toMatch(/create or replace function public\.commit_course_revoice_job/i);
    expect(sql).toMatch(/where id = p_job_id and course_id = p_course_id and status = 'running'/i);
    expect(sql).toMatch(/and updated_at = p_source_updated_at/i);
    expect(sql).toMatch(/return 'cancelled'/i);
  });
});
