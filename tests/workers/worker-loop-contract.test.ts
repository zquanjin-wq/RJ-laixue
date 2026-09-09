import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const worker = (name: string) =>
  readFileSync(resolve(process.cwd(), 'scripts', name), 'utf8');

describe('durable worker loop contracts', () => {
  it('runs video exports as an independently deployable leased agent', () => {
    const source = worker('run-course-video-export-agent.ts');
    expect(source).toContain('COURSE_VIDEO_EXPORT_WORKER_ID');
    expect(source).toContain('COURSE_VIDEO_EXPORT_LEASE_MS');
    expect(source).toContain('runNextCourseVideoExport({ workerId, leaseMs })');
    expect(source).toContain('COURSE_VIDEO_EXPORT_INTERVAL_MS must be at least 1000');
  });

  it('does not overlap revoice worker ticks', () => {
    const source = worker('run-course-revoice-worker.mjs');
    expect(source).toContain('for (;;)');
    expect(source).not.toContain('setInterval(');
  });

  it('allows a complete PPTX narration run to finish before timing out', () => {
    const source = worker('run-classroom-generation-worker.mjs');
    expect(source).toContain('const requestTimeoutMs = 890_000');
    expect(source).toContain('AbortSignal.timeout(requestTimeoutMs)');
  });
});
