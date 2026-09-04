import { describe, expect, it } from 'vitest';
import {
  COURSE_ASSET_CORS_ALLOWED_HEADERS,
  COURSE_ASSET_CORS_METHODS,
  createCourseAssetCorsConfiguration,
  getCourseAssetCorsOrigins,
} from '@/lib/server/cos-cors';

describe('course asset COS CORS configuration', () => {
  it('allows browser uploads and audio range reads from production and local development', () => {
    const origins = getCourseAssetCorsOrigins(undefined);
    const configuration = createCourseAssetCorsConfiguration(origins);

    expect(origins).toEqual(['https://laixue.online', 'http://localhost:3000']);
    expect(configuration.CORSRules).toEqual([
      expect.objectContaining({
        AllowedOrigin: origins,
        AllowedMethod: COURSE_ASSET_CORS_METHODS,
        AllowedHeader: COURSE_ASSET_CORS_ALLOWED_HEADERS,
      }),
    ]);
  });

  it('accepts a deployment-specific, comma-separated origin list', () => {
    expect(getCourseAssetCorsOrigins('https://laixue.online, https://preview.laixue.online')).toEqual([
      'https://laixue.online',
      'https://preview.laixue.online',
    ]);
  });

  it('rejects origins with paths', () => {
    expect(() => getCourseAssetCorsOrigins('https://laixue.online/path')).toThrow(
      'COS_CORS_ORIGINS must contain comma-separated origins without paths',
    );
  });
});
