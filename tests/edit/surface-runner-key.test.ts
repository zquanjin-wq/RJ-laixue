import { describe, expect, it } from 'vitest';
import { surfaceRunnerKey } from '@/lib/edit/surface-runner-key';

describe('surfaceRunnerKey', () => {
  it('remounts when a lazy editor surface replaces the noop fallback', () => {
    expect(surfaceRunnerKey('slide', null)).not.toBe(surfaceRunnerKey('slide', 'slide'));
  });

  it('stays stable when deleting a slide selects another slide', () => {
    expect(surfaceRunnerKey('slide', 'slide')).toBe(surfaceRunnerKey('slide', 'slide'));
  });

  it('remounts when navigation changes to a different registered scene type', () => {
    expect(surfaceRunnerKey('slide', 'slide')).not.toBe(surfaceRunnerKey('quiz', 'quiz'));
  });
});
