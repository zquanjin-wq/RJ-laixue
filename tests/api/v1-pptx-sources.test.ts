import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  pool: vi.fn(),
  createAsset: vi.fn(),
  markAssetReady: vi.fn(),
  createCourse: vi.fn(),
  getSource: vi.fn(),
  registerSource: vi.fn(),
  uploadUrl: vi.fn(),
  assertObjectExists: vi.fn(),
}));

vi.mock('@/lib/server/api-token', () => ({ resolveApiToken: mocks.actor }));
vi.mock('@/lib/server/db/pool', () => ({ getDatabasePool: mocks.pool }));
vi.mock('@/lib/server/cos-storage', () => ({
  CosStorage: class {
    getUploadUrl = mocks.uploadUrl;
    assertObjectExists = mocks.assertObjectExists;
  },
}));
vi.mock('@/lib/server/db/course-repository', () => ({
  CourseRepository: class {
    createAsset = mocks.createAsset;
    markAssetReady = mocks.markAssetReady;
    createCourse = mocks.createCourse;
  },
}));
vi.mock('@/lib/server/db/pptx-source-repository', () => ({
  PptxSourceRepository: class {
    getOwned = mocks.getSource;
    register = mocks.registerSource;
  },
}));

const authHeaders = { authorization: 'Bearer laix_test' };

afterEach(() => vi.resetAllMocks());

describe('v1 PPTX source API', () => {
  it('creates a token-authorized direct upload session', async () => {
    mocks.actor.mockResolvedValue({
      userId: 'teacher-1',
      role: 'teacher',
      scopes: ['classroom:write'],
    });
    mocks.createAsset.mockResolvedValue({ id: '944ebd1d-864c-419e-a327-7a7691fbf917' });
    mocks.uploadUrl.mockResolvedValue('https://cos.example/upload');
    const { POST } = await import('@/app/api/v1/pptx-sources/route');
    const response = await POST(
      new NextRequest('http://localhost/api/v1/pptx-sources', {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: '培训课件.pptx', sizeBytes: 1024 }),
      }),
    );
    expect(response.status).toBe(201);
    expect(mocks.createAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: 'teacher-1',
        kind: 'material',
        sizeBytes: 1024,
      }),
    );
    expect(await response.json()).toMatchObject({
      assetId: '944ebd1d-864c-419e-a327-7a7691fbf917',
      uploadUrl: 'https://cos.example/upload',
    });
  });

  it('rejects an API token without classroom write scope', async () => {
    mocks.actor.mockResolvedValue({
      userId: 'teacher-1',
      role: 'teacher',
      scopes: ['classroom:read'],
    });
    const { POST } = await import('@/app/api/v1/pptx-sources/route');
    const response = await POST(
      new NextRequest('http://localhost/api/v1/pptx-sources', {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: '培训课件.pptx', sizeBytes: 1024 }),
      }),
    );
    expect(response.status).toBe(401);
    expect(mocks.createAsset).not.toHaveBeenCalled();
  });
});
