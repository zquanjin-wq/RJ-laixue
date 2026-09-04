import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), 'db/migrations/0008_learning_analytics_and_revoice.sql'), 'utf8');
const route = readFileSync(resolve(process.cwd(), 'app/api/courses/[id]/revoice/route.ts'), 'utf8');

describe('course revoice database invariants', () => {
  it('allows only one active job per course', () => {
    expect(sql).toMatch(/create table if not exists app\.course_revoice_jobs/i);
    expect(sql).toMatch(/create unique index if not exists[\s\S]*on app\.course_revoice_jobs \(course_id\)[\s\S]*where status in \('queued', 'running'\)/i);
  });

  it('keeps the worker state required by PostgreSQL repositories', () => {
    expect(sql).toMatch(/locked_until timestamptz/i);
    expect(sql).toMatch(/completed_at timestamptz/i);
    expect(sql).toMatch(/source_updated_at timestamptz not null/i);
  });

  it('can safely be re-run when the database was migrated manually', () => {
    expect(sql).toMatch(/create table if not exists app\.ai_learning_summaries/i);
    expect(sql).toMatch(/create index if not exists ai_learning_summaries_task_created_idx/i);
    expect(sql).toMatch(/create table if not exists app\.ai_intervention_suggestions/i);
    expect(sql).toMatch(/create table if not exists app\.ai_intervention_targets/i);
  });

  it('uses database-backed course ownership checks without disclosing inaccessible courses', () => {
    expect(route).toContain("canManageCourse(actor, courseId)");
    expect(route).not.toContain("apiError('FORBIDDEN', 403");
    expect(route).toContain('cancelCourseRevoiceJob(jobId, id)');
  });
});
