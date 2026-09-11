import { describe, expect, it } from 'vitest';
import { VIDEO_EXPORT_PROFILE } from '@/lib/export/video-export-contract';

describe('video export profile', () => {
  it('always uses the single 720p 20fps profile', () => {
    expect(VIDEO_EXPORT_PROFILE).toEqual({
      fps: 20,
      quality: 'draft',
      width: 1280,
      height: 720,
    });
  });
});
