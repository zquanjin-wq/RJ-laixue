import COS from 'cos-nodejs-sdk-v5';
import {
  createCourseAssetCorsConfiguration,
  getCourseAssetCorsOrigins,
} from '../lib/server/cos-cors';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const bucket = required('TENCENT_COS_BUCKET');
  const region = required('TENCENT_COS_REGION');
  const client = new COS({
    SecretId: required('TENCENT_COS_SECRET_ID'),
    SecretKey: required('TENCENT_COS_SECRET_KEY'),
  });
  const origins = getCourseAssetCorsOrigins();

  await client.putBucketCors({
    Bucket: bucket,
    Region: region,
    CORSRules: createCourseAssetCorsConfiguration(origins).CORSRules,
  });

  console.log(`Configured COS CORS for ${bucket}: ${origins.join(', ')}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
