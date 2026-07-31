import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  isServerConfiguredProvider: vi.fn(() => false),
  resolvePDFApiKey: vi.fn((_providerId: string, clientKey?: string) => clientKey || ''),
  resolvePDFBaseUrl: vi.fn((_providerId: string, clientBaseUrl?: string) => clientBaseUrl),
  parsePDF: vi.fn(),
  parseWithMinerUCloud: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: mocks.isServerConfiguredProvider,
  resolvePDFApiKey: mocks.resolvePDFApiKey,
  resolvePDFBaseUrl: mocks.resolvePDFBaseUrl,
}));

vi.mock('@/lib/pdf/mineru-cloud', () => ({
  parseWithMinerUCloud: mocks.parseWithMinerUCloud,
}));

vi.mock('@/lib/pdf/pdf-providers', () => ({
  parsePDF: mocks.parsePDF,
  parseWithMinerUDocument: vi.fn(),
}));

async function postExtractDocument(input: {
  file: File;
  providerId?: string;
  apiKey?: string;
  baseUrl?: string;
}) {
  const { POST } = await import('@/app/api/extract-document/route');
  const formData = new FormData();
  formData.append('file', input.file);
  if (input.providerId) formData.append('providerId', input.providerId);
  if (input.apiKey) formData.append('apiKey', input.apiKey);
  if (input.baseUrl) formData.append('baseUrl', input.baseUrl);

  const request = new Request('http://localhost/api/extract-document', {
    method: 'POST',
    body: formData,
  });
  return POST(request as unknown as NextRequest);
}

describe('POST /api/extract-document', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mocks.isServerConfiguredProvider.mockReturnValue(false);
    mocks.resolvePDFApiKey.mockImplementation(
      (_providerId: string, clientKey?: string) => clientKey || '',
    );
    mocks.resolvePDFBaseUrl.mockImplementation(
      (_providerId: string, clientBaseUrl?: string) => clientBaseUrl,
    );
    mocks.parsePDF.mockReset();
    mocks.parsePDF.mockResolvedValue({
      text: 'unpdf parsed text',
      images: [],
      metadata: { pageCount: 1, parser: 'unpdf' },
    });
    mocks.parseWithMinerUCloud.mockReset();
    mocks.parseWithMinerUCloud.mockResolvedValue({
      text: 'cloud parsed text',
      images: [],
      metadata: {
        pageCount: 1,
        parser: 'mineru-cloud',
      },
    });
    delete process.env.PDF_MINERU_BASE_URL;
    delete process.env.PDF_MINERU_API_KEY;
  });

  it('returns 400 for unsupported course material MIME types', async () => {
    const res = await postExtractDocument({
      file: new File(['x,y'], 'sheet.csv', { type: 'text/csv' }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
  });

  it('returns 400 for an unknown requested provider', async () => {
    const res = await postExtractDocument({
      file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
      providerId: 'missing-provider',
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'Unknown document extractor provider: missing-provider',
    });
  });

  it('treats an incompatible preferred provider as a hint and falls back by MIME type', async () => {
    const res = await postExtractDocument({
      file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
      providerId: 'unpdf',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      data: {
        text: 'hello',
        metadata: {
          mimeType: 'text/plain',
          parser: 'plain-text',
        },
      },
    });
  });

  it('returns actionable 422 diagnostics when DOCX requires unconfigured MinerU', async () => {
    const res = await postExtractDocument({
      file: new File(['not really docx'], 'lesson.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    });
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(json.error).toContain('DOCX extraction requires a configured MinerU document extractor');
    expect(json.error).toContain('self-hosted MinerU base URL or a MinerU Cloud API key');
  });

  it('falls back to unpdf when a stale self-hosted MinerU preference cannot parse a PDF', async () => {
    const res = await postExtractDocument({
      file: new File(['not really a PDF'], 'lesson.pdf', { type: 'application/pdf' }),
      providerId: 'mineru',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      data: { metadata: { parser: 'unpdf' } },
    });
    expect(mocks.parsePDF).toHaveBeenCalledTimes(1);
  });

  it('falls back to unpdf when a stale MinerU Cloud preference has no API key', async () => {
    const res = await postExtractDocument({
      file: new File(['not really a PDF'], 'lesson.pdf', { type: 'application/pdf' }),
      providerId: 'mineru-cloud',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      data: { metadata: { parser: 'unpdf' } },
    });
    expect(mocks.parseWithMinerUCloud).not.toHaveBeenCalled();
    expect(mocks.parsePDF).toHaveBeenCalledTimes(1);
  });

  it('allows MinerU Cloud PDF extraction with an API key and no base URL', async () => {
    const res = await postExtractDocument({
      file: new File(['%PDF-1.4'], 'lesson.pdf', { type: 'application/pdf' }),
      providerId: 'mineru-cloud',
      apiKey: 'cloud-key',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      data: {
        text: 'cloud parsed text',
        metadata: {
          parser: 'mineru-cloud',
        },
      },
    });
    expect(mocks.parseWithMinerUCloud).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'mineru-cloud',
        apiKey: 'cloud-key',
        baseUrl: undefined,
      }),
      expect.any(Buffer),
      'lesson.pdf',
    );
  });

  it('falls back to MinerU Cloud for DOCX when self-hosted MinerU is unavailable and a cloud key is provided', async () => {
    const res = await postExtractDocument({
      file: new File(['not really docx'], 'lesson.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      apiKey: 'cloud-key',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      data: {
        text: 'cloud parsed text',
        metadata: {
          parser: 'mineru-cloud',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      },
    });
    expect(mocks.parseWithMinerUCloud).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'mineru-cloud',
        apiKey: 'cloud-key',
        baseUrl: undefined,
      }),
      expect.any(Buffer),
      'lesson.docx',
    );
  });
});
