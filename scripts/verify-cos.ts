import { CosStorage } from '../lib/server/cos-storage';

const BROWSER_ORIGIN = 'https://laixue.online';

function allowOrigin(response: Response): string | null {
  return response.headers.get('access-control-allow-origin');
}

async function main() {
  const storage = new CosStorage();
  const key = `system-check/${Date.now()}-connectivity.txt`;
  const content = Buffer.from('laixue COS connectivity check', 'utf8');

  try {
    const uploadUrl = await storage.getUploadUrl(key, 60);

    const preflight = await fetch(uploadUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: BROWSER_ORIGIN,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    if (!preflight.ok || ![BROWSER_ORIGIN, '*'].includes(allowOrigin(preflight) ?? '')) {
      throw new Error(
        `COS browser upload preflight failed: HTTP ${preflight.status}, allow-origin=${allowOrigin(preflight) ?? '(missing)'}`,
      );
    }

    const upload = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: content,
    });
    if (!upload.ok) throw new Error(`Signed COS upload returned ${upload.status}`);

    const downloaded = await storage.getObject(key);
    if (!downloaded.equals(content)) throw new Error('Downloaded COS content does not match');

    const range = await storage.getObject(key, 'bytes=0-5');
    if (range.toString('utf8') !== content.subarray(0, 6).toString('utf8')) {
      throw new Error('COS Range response does not match');
    }

    const signedUrl = await storage.getDownloadUrl(key, 60);
    const response = await fetch(signedUrl, { headers: { Range: 'bytes=0-5' } });
    if (response.status !== 206)
      throw new Error(`Signed COS Range request returned ${response.status}`);

    console.log('COS 验证通过：直传上传、私有读取、Range 读取和临时访问地址均正常');
  } finally {
    await storage.deleteObject(key).catch(() => undefined);
  }
}

void main();
