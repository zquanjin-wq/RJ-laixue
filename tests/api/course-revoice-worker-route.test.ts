import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const route = readFileSync(
  resolve(process.cwd(), 'app/api/cron/course-revoice/route.ts'),
  'utf8',
);

describe('course revoice worker route', () => {
  it('requires the cron secret and returns observable batch progress', () => {
    expect(route).toContain("request.headers.get('authorization') !== `Bearer ${secret}`");
    expect(route).toContain('completed: job.completed_items');
    expect(route).toContain('total: job.total_items');
  });

  it('returns a server error when the worker invocation fails', () => {
    expect(route).toContain("{ success: false, error: message }, { status: 500 }");
  });
});
