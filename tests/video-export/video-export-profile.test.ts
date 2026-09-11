import { describe, expect, it } from 'vitest';
import { resolveVideoExportProfile } from '@/lib/export/video-export-contract';

describe('video export profiles', () => {
  it('uses 720p at 24fps by default', () => {
    expect(resolveVideoExportProfile(undefined)).toEqual({
      preset: 'standard',
      fps: 24,
      quality: 'standard',
      width: 1280,
      height: 720,
    });
  });

  it('uses 720p at 20fps for fast exports', () => {
    expect(resolveVideoExportProfile('fast')).toEqual({
      preset: 'fast',
      fps: 20,
      quality: 'draft',
      width: 1280,
      height: 720,
    });
  });
});
