import COS from 'cos-nodejs-sdk-v5';

export interface CosStorageConfig {
  bucket: string;
  region: string;
  secretId: string;
  secretKey: string;
}

function loadConfig(): CosStorageConfig {
  const bucket = process.env.TENCENT_COS_BUCKET;
  const region = process.env.TENCENT_COS_REGION;
  const secretId = process.env.TENCENT_COS_SECRET_ID;
  const secretKey = process.env.TENCENT_COS_SECRET_KEY;
  if (!bucket || !region || !secretId || !secretKey) {
    throw new Error('Tencent COS environment variables are required');
  }
  return { bucket, region, secretId, secretKey };
}

export class CosStorage {
  private readonly config: CosStorageConfig;
  private readonly client: COS;

  constructor(config = loadConfig()) {
    this.config = config;
    this.client = new COS({ SecretId: config.secretId, SecretKey: config.secretKey });
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.putObject({
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: key,
      Body: body,
      ContentLength: body.length,
      ContentType: contentType,
    });
  }

  async getObject(key: string, range?: string): Promise<Buffer> {
    const result = await this.client.getObject({
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: key,
      Range: range,
    });
    return result.Body;
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.deleteObject({
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: key,
    });
  }

  async getDownloadUrl(key: string, expiresInSeconds = 900): Promise<string> {
    return this.client.getObjectUrl({
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: key,
      Sign: true,
      Method: 'GET',
      Protocol: 'https:',
      Expires: expiresInSeconds,
    });
  }

  async getUploadUrl(key: string, expiresInSeconds = 900): Promise<string> {
    return this.client.getObjectUrl({
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: key,
      Sign: true,
      Method: 'PUT',
      Protocol: 'https:',
      Expires: expiresInSeconds,
    });
  }
}
