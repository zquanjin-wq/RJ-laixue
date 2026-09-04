import { describe, expect, it } from 'vitest';
import { CourseRevoiceError, describeCourseRevoiceError } from '@/lib/server/course-revoice-jobs';

describe('course revoice error mapping', () => {
  it('reports a missing revoice migration instead of a generic creation failure', () => {
    expect(describeCourseRevoiceError({ code: '42P01' })).toMatchObject({
      code: 'REVOICE_DATABASE_MIGRATION_REQUIRED',
      status: 503,
    });
  });

  it('preserves actionable validation failures', () => {
    const failure = new CourseRevoiceError('NO_REVOICE_ITEMS', '课程中没有可重新配音的语音片段。', 422);
    expect(describeCourseRevoiceError(failure)).toBe(failure);
  });

  it('maps Better Auth foreign-key synchronization failures safely', () => {
    expect(describeCourseRevoiceError({ code: '23503' })).toMatchObject({
      code: 'REVOICE_AUTH_SYNC_REQUIRED',
      status: 409,
    });
  });
});
