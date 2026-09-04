const DEFAULT_ORIGINS = ['https://laixue.online', 'http://localhost:3000'];

export const COURSE_ASSET_CORS_METHODS = ['PUT', 'GET', 'HEAD'];
export const COURSE_ASSET_CORS_ALLOWED_HEADERS = ['Content-Type', 'Range'];
export const COURSE_ASSET_CORS_EXPOSE_HEADERS = [
  'ETag',
  'Content-Length',
  'Content-Range',
  'Accept-Ranges',
];

export interface CosCorsConfiguration {
  CORSRules: Array<{
    AllowedOrigin: string[];
    AllowedMethod: string[];
    AllowedHeader: string[];
    ExposeHeader: string[];
    MaxAgeSeconds: number;
  }>;
}

export function getCourseAssetCorsOrigins(value = process.env.COS_CORS_ORIGINS): string[] {
  const origins = (value ? value.split(',') : DEFAULT_ORIGINS).map((origin) => origin.trim());
  const uniqueOrigins = [...new Set(origins.filter(Boolean))];
  if (uniqueOrigins.length === 0) throw new Error('COS_CORS_ORIGINS must contain at least one origin');
  if (uniqueOrigins.some((origin) => !/^https?:\/\/[^/]+$/i.test(origin))) {
    throw new Error('COS_CORS_ORIGINS must contain comma-separated origins without paths');
  }
  return uniqueOrigins;
}

export function createCourseAssetCorsConfiguration(origins = getCourseAssetCorsOrigins()): CosCorsConfiguration {
  return {
    CORSRules: [
      {
        AllowedOrigin: origins,
        AllowedMethod: COURSE_ASSET_CORS_METHODS,
        AllowedHeader: COURSE_ASSET_CORS_ALLOWED_HEADERS,
        ExposeHeader: COURSE_ASSET_CORS_EXPOSE_HEADERS,
        MaxAgeSeconds: 600,
      },
    ],
  };
}
