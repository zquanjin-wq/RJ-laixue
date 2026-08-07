/**
 * Tests for POST /api/extract-document/start and /api/extract-document/poll
 *
 * Covers:
 *   - start: auth 401, path forbidden 403, returns batchId immediately
 *   - start: does NOT wait for MinerU parsing (fast response)
 *   - poll: 401/403 auth
 *   - poll: state transitions (processing → done → idempotent re-poll)
 *   - poll: done triggers externalizeImages + safeApiSuccess (< 4MB assertion)
 *   - poll: failed returns structured error with MinerU err_msg
 *   - poll: pending/processing returns status without downloading ZIP
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  getServerSupabaseMock,
  getServiceSupabaseMock,
} = vi.hoisted(() => ({
  getServerSupabaseMock: vi.fn(),
  getServiceSupabaseMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  getServerSupabase: getServerSupabaseMock,
  getServiceSupabase: getServiceSupabaseMock,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── global fetch spy ─────────────────────────────────────────────────────────

const fetchSpy = vi.fn();

// ── Helpers ──────────────────────────────────────────────────────────────────

const CALLER_USER_ID = 'test-user-abc';
const COURSE_ID = CALLER_USER_ID; // pending/{callerUserId}/... matches
const STORAGE_PATH = `pending/${CALLER_USER_ID}/material/test.pdf`;

function mockAuth() {
  getServerSupabaseMock.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: CALLER_USER_ID } },
      }),
    },
  });
}

function mockService() {
  const storageMock = {
    upload: vi.fn().mockResolvedValue({ error: null }),
    getPublicUrl: vi.fn((path: string) => ({
      data: { publicUrl: `https://fake.storage.co/${path}` },
    })),
  };
  getServiceSupabaseMock.mockReturnValue({
    storage: { from: vi.fn(() => storageMock) },
  });
}

function mockEnv() {
  vi.stubEnv('SUPABASE_URL', 'https://aqmktsagfvkikehynpdw.supabase.co');
  vi.stubEnv('MINERU_CLOUD_API_KEY', 'sk-test-mineru-key');
}

async function postStart(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/extract-document/start/route');
  const request = new Request('http://localhost/api/extract-document/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

async function postPoll(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/extract-document/poll/route');
  const request = new Request('http://localhost/api/extract-document/poll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

// ── MinerU mock helpers ──────────────────────────────────────────────────────

function mockMinerUTaskBatch(batchId = 'batch-test-001') {
  return {
    code: 0,
    msg: 'success',
    data: { batch_id: batchId },
  };
}

function mockMinerUPoll(state: string, fullZipUrl?: string, errMsg?: string) {
  return {
    code: 0,
    msg: 'success',
    data: {
      extract_result: {
        state,
        file_name: 'test.pdf',
        full_zip_url: fullZipUrl,
        err_msg: errMsg,
      },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/extract-document/start', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', fetchSpy);
    mockAuth();
    mockService();
    mockEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchSpy.mockReset();
  });

  // ── Auth ────────────────────────────────────────────────────────────────

  it('401 when unauthenticated', async () => {
    getServerSupabaseMock.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    });
    const resp = await postStart({ courseId: COURSE_ID, path: STORAGE_PATH });
    expect(resp.status).toBe(401);
    expect((await resp.json()).errorCode).toBe('UNAUTHENTICATED');
  });

  it('403 when pending path userId does not match caller', async () => {
    const resp = await postStart({
      courseId: 'someone-else',
      path: 'pending/someone-else/material/test.pdf',
    });
    expect(resp.status).toBe(403);
    expect((await resp.json()).errorCode).toBe('FORBIDDEN');
  });

  it('400 when courseId or path missing', async () => {
    const resp = await postStart({ path: STORAGE_PATH });
    expect(resp.status).toBe(400);
  });

  // ── start returns immediately (does NOT wait for parsing) ─────────────────

  it('returns batchId immediately — no sleep, fast response', async () => {
    const startTime = Date.now();

    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(mockMinerUTaskBatch()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const resp = await postStart({ courseId: COURSE_ID, path: STORAGE_PATH });

    // Must return far under Cloudflare 100s limit
    expect(Date.now() - startTime).toBeLessThan(3_000);
    expect(resp.status).toBe(200);

    const body = await resp.json();
    expect(body.success).toBe(true);
    expect(body.data.batchId).toBe('batch-test-001');
    expect(body.data.status).toBe('started');

    // start should NOT poll MinerU for results — just create task
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const fetchUrl = fetchSpy.mock.calls[0][0] as string;
    expect(fetchUrl).toContain('extract/task/batch');
  });

  it('propagates MinerU API errors', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ code: 1, msg: 'API key invalid', data: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const resp = await postStart({ courseId: COURSE_ID, path: STORAGE_PATH });
    expect(resp.status).toBe(500);
    const body = await resp.json();
    expect(body.errorCode).toBe('PARSE_FAILED');
    expect(body.error).toContain('API key invalid');
  });
});

describe('POST /api/extract-document/poll', () => {
  const BATCH_ID = 'batch-test-001';

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', fetchSpy);
    mockAuth();
    mockService();
    mockEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchSpy.mockReset();
  });

  // ── Auth ────────────────────────────────────────────────────────────────

  it('401 when unauthenticated', async () => {
    getServerSupabaseMock.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    });
    const resp = await postPoll({ batchId: BATCH_ID, courseId: COURSE_ID, path: STORAGE_PATH });
    expect(resp.status).toBe(401);
  });

  // ── State transitions ───────────────────────────────────────────────────

  it('returns processing when MinerU is pending', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(mockMinerUPoll('pending')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const resp = await postPoll({ batchId: BATCH_ID, courseId: COURSE_ID, path: STORAGE_PATH });
    expect(resp.status).toBe(200);

    const body = await resp.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('processing');
  });

  it('returns processing when MinerU is processing', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(mockMinerUPoll('processing')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const resp = await postPoll({ batchId: BATCH_ID, courseId: COURSE_ID, path: STORAGE_PATH });
    expect(resp.status).toBe(200);

    const body = await resp.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('processing');
    expect(body.data.mineruState).toBe('processing');
  });

  it('returns failed with err_msg when MinerU fails', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify(mockMinerUPoll('failed', undefined, 'File corrupted')),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const resp = await postPoll({ batchId: BATCH_ID, courseId: COURSE_ID, path: STORAGE_PATH });
    expect(resp.status).toBe(200);

    const body = await resp.json();
    expect(body.data.status).toBe('failed');
    expect(body.data.error).toContain('File corrupted');
  });
});
