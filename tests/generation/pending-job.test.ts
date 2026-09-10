import { describe, expect, it } from 'vitest';
import { parsePendingGenerationJob } from '@/lib/generation/pending-job';

describe('pending durable generation handle', () => {
  it('accepts the minimal, browser-safe resume handle', () => {
    expect(
      parsePendingGenerationJob({
        jobId: 'job-1',
        courseId: 'course-1',
        pollUrl: '/api/generation-jobs/job-1',
        kind: 'pptx',
        createdAt: 123,
      }),
    ).toEqual({
      jobId: 'job-1',
      courseId: 'course-1',
      pollUrl: '/api/generation-jobs/job-1',
      kind: 'pptx',
      createdAt: 123,
    });
  });

  it('rejects incomplete, malformed, or unsupported handles', () => {
    expect(parsePendingGenerationJob(null)).toBeNull();
    expect(parsePendingGenerationJob({ jobId: 'job-1' })).toBeNull();
    expect(
      parsePendingGenerationJob({
        jobId: 'job-1',
        courseId: 'course-1',
        pollUrl: '/api/generation-jobs/job-1',
        kind: 'other',
        createdAt: 123,
      }),
    ).toBeNull();
  });
});
