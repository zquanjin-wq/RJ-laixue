/**
 * Tests for `saveStageToCloud` Phase 0 (ensure course row exists before
 * publishing audio). The bug fixed here was caused by upstream commit
 * 3d80b985 (2026-07-28) on production: sign-upload requires the course row
 * to exist in the `courses` table, but saveStageToCloud historically created
 * the row at the END of save (Phase 3), so a brand-new course's first save
 * hit a chicken-and-egg: every audio upload → 404 → 166 failed → save
 * blocked. Phase 0 pre-upserts the course row before Phase 1.
 *
 * The most important assertion is the ORDER: the course-row POST must happen
 * before any sign-upload POST, otherwise sign-upload will 404 again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the heavy modules that saveStageToCloud reaches into. We keep
// behaviour pinned to a single Phase 1 fetch (a sign-upload POST) so the
// test can assert ordering across Phase 0 and Phase 1.
vi.mock('@/lib/utils/database', () => {
  const stageRow = {
    id: 'stage-new-1',
    name: '新建课件测试',
    sceneOrderTrusted: true,
    teacherVoiceConfig: null,
  };
  const scenes = [
    { id: 'scene-1', stageId: 'stage-new-1', order: 0, actions: [] },
    { id: 'scene-2', stageId: 'stage-new-1', order: 1, actions: [] },
  ];
  const outlines = [{ id: 'o1', stageId: 'stage-new-1', order: 0 }];
  return {
    db: {
      stages: {
        get: vi.fn(async () => stageRow),
        put: vi.fn(async () => undefined),
      },
      // Mimic the dexie fluent builder: where(field).equals(value).toArray().
      scenes: {
        where: vi.fn((_field: string) => ({
          equals: vi.fn((_value: string) => ({
            toArray: vi.fn(async () => scenes),
            delete: vi.fn(async () => undefined),
          })),
        })),
        bulkPut: vi.fn(async () => undefined),
      },
      stageOutlines: {
        where: vi.fn((_field: string) => ({
          equals: vi.fn((_value: string) => ({
            toArray: vi.fn(async () => outlines),
          })),
        })),
      },
    },
  };
});

vi.mock('@/lib/audio/audio-publish', () => ({
  publishSceneAudioAssets: vi.fn(async (stageId: string, scenes: unknown[]) => {
    // Emit a single sign-upload POST so the test can assert the Phase 0/Phase 1
    // ordering. We DO NOT call /api/courses/[id] GET here — that's Phase 0's
    // job, and Phase 1 only fires sign-upload calls.
    await fetch('/api/course-assets/sign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stageId }),
    });
    return {
      uploaded: [],
      skipped: [],
      missing: [],
      failed: [],
      regenerated: [],
      scenes,
    };
  }),
  validatePublishedAudioAssets: vi.fn(() => ({
    ok: true,
    issues: [],
    totalLearnable: 0,
    validCount: 0,
  })),
}));

vi.mock('@/lib/course-assets/externalize', () => ({
  externalizeCourseAssets: vi.fn(async (_id: string, stage: unknown, scenes: unknown[]) => ({
    stage,
    scenes,
    converted: { images: 0, audio: 0 },
  })),
}));

vi.mock('@/lib/dsl-extensions/serialize', () => ({
  stripRuntimeOnly: vi.fn((stage: unknown) => stage),
}));

vi.mock('@/lib/supabase/client', () => ({
  supabase: { storage: { from: () => ({ uploadToSignedUrl: vi.fn() }) } },
}));

vi.mock('@/lib/utils/scene-order', () => ({
  orderSceneRecordsForDisplay: vi.fn((scenes: unknown[]) => ({
    ordered: scenes,
    source: 'auto',
    duplicateIdsRemoved: [],
  })),
}));

// Lazy import so the module-level vi.mock above takes effect first.
const { saveStageToCloud, recordLearningEvent } = await import('@/lib/utils/cloud-sync');

interface FetchCall {
  url: string;
  method: string;
  body?: string;
}

let fetchCalls: FetchCall[] = [];
let realFetch: typeof fetch | undefined;
let nextResponseIndex = 0;
let responseQueue: Array<{ status: number; body: unknown }> = [];

function enqueueResponse(status: number, body: unknown) {
  responseQueue.push({ status, body });
}

beforeEach(() => {
  fetchCalls = [];
  responseQueue = [];
  nextResponseIndex = 0;
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    fetchCalls.push({ url, method, body });
    const queued = responseQueue[nextResponseIndex++] ?? {
      status: 200,
      body: { success: true, data: {} },
    };
    return new Response(JSON.stringify(queued.body), {
      status: queued.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  if (realFetch) globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

// Helper to find the index of the first call matching a path+method predicate.
function findCall(pred: (c: FetchCall) => boolean): number {
  return fetchCalls.findIndex(pred);
}

describe('saveStageToCloud — Phase 0 course-row pre-upsert', () => {
  it('new course: GET 404 → POST /api/courses with full payload → then sign-upload POST', async () => {
    // 1) Phase 0 probe GET → 404
    enqueueResponse(404, { success: false, error: '课程不存在' });
    // 2) Phase 0 upsert POST → 200
    enqueueResponse(200, { success: true, data: { id: 'stage-new-1' } });
    // 3) Phase 1 sign-upload POST → 200
    enqueueResponse(200, { success: true, data: { path: 'x', token: 't', publicUrl: 'u' } });
    // 4) Phase 3 final POST /api/courses → 200 (covered by the next available response)
    enqueueResponse(200, { success: true, data: { id: 'stage-new-1' } });

    await saveStageToCloud('stage-new-1');

    // ── Order assertion (the soul of the fix card) ──
    const probeIdx = findCall((c) => c.method === 'GET' && c.url === '/api/courses/stage-new-1');
    const createIdx = findCall(
      (c) =>
        c.method === 'POST' &&
        c.url === '/api/courses' &&
        // First POST to /api/courses is Phase 0; Phase 3 comes after.
        // Confirm payload shape to be sure.
        !!c.body?.includes('"id":"stage-new-1"'),
    );
    const signUploadIdx = findCall(
      (c) => c.method === 'POST' && c.url === '/api/course-assets/sign-upload',
    );

    expect(probeIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(probeIdx);
    // sign-upload must fire AFTER the course-row POST (Phase 0 has to win the
    // race against sign-upload's 404-on-missing-row check).
    expect(signUploadIdx).toBeGreaterThan(createIdx);

    // ── Payload assertion (per Kimi: full data, not empty stub) ──
    const createPayload = JSON.parse(fetchCalls[createIdx].body!);
    expect(createPayload.id).toBe('stage-new-1');
    expect(createPayload.title).toBe('新建课件测试');
    expect(createPayload.data.stage.id).toBe('stage-new-1');
    // Full scenes + outlines — NOT the empty stub `{stage:{id,name},scenes:[],outlines:[]}`.
    expect(createPayload.data.scenes).toHaveLength(2);
    expect(createPayload.data.outlines).toHaveLength(1);
  });

  it('existing course: GET 200 → no Phase 0 POST; sign-upload fires directly', async () => {
    // 1) Phase 0 probe GET → 200 (row exists)
    enqueueResponse(200, { success: true, data: { id: 'stage-new-1' } });
    // 2) Phase 1 sign-upload POST → 200
    enqueueResponse(200, { success: true, data: { path: 'x', token: 't', publicUrl: 'u' } });
    // 3) Phase 3 final POST /api/courses → 200
    enqueueResponse(200, { success: true, data: { id: 'stage-new-1' } });

    await saveStageToCloud('stage-new-1');

    // ── No Phase 0 POST when the probe succeeds ──
    const probeIdx = findCall((c) => c.method === 'GET' && c.url === '/api/courses/stage-new-1');
    expect(probeIdx).toBeGreaterThanOrEqual(0);

    // The very first POST to /api/courses should be Phase 3 (final save), not
    // Phase 0 (upsert). So we count POSTs to /api/courses and confirm the
    // first one is Phase 3 — i.e. only one POST to /api/courses (no Phase 0
    // upsert at all).
    const postsToCourses = fetchCalls.filter(
      (c) => c.method === 'POST' && c.url === '/api/courses',
    );
    expect(postsToCourses).toHaveLength(1);

    // sign-upload still fires (Phase 1 is unchanged).
    const signUploadIdx = findCall(
      (c) => c.method === 'POST' && c.url === '/api/course-assets/sign-upload',
    );
    expect(signUploadIdx).toBeGreaterThanOrEqual(0);
  });

  it('probe failure (500): aborts before any asset upload', async () => {
    enqueueResponse(500, { success: false, error: 'internal_error' });

    await expect(saveStageToCloud('stage-new-1')).rejects.toThrow('Course preparation failed');

    const probeIdx = findCall((c) => c.method === 'GET' && c.url === '/api/courses/stage-new-1');
    expect(probeIdx).toBeGreaterThanOrEqual(0);
    expect(fetchCalls.filter((c) => c.method === 'POST' && c.url === '/api/courses')).toHaveLength(
      0,
    );
    expect(findCall((c) => c.method === 'POST' && c.url === '/api/course-assets/sign-upload')).toBe(
      -1,
    );
  });
});

describe('recordLearningEvent — client contract', () => {
  it('records learner event and returns recorded:true', async () => {
    enqueueResponse(200, { success: true, recorded: true });

    const result = await recordLearningEvent({
      courseId: 'course-1',
      eventType: 'open_course',
    });

    expect(result.recorded).toBe(true);

    const call = fetchCalls.find((c) => c.method === 'POST' && c.url === '/api/learning/events');
    expect(call).toBeDefined();
    const payload = JSON.parse(call?.body ?? '{}');
    expect(payload.courseId).toBe('course-1');
    expect(payload.eventType).toBe('open_course');
    expect(payload.studentId).toBeUndefined();
  });

  it('preview recorded:false does not throw and is surfaced to caller', async () => {
    enqueueResponse(200, { success: true, recorded: false, reason: 'preview', role: 'teacher' });

    const result = await recordLearningEvent({
      courseId: 'course-1',
      eventType: 'open_course',
    });

    expect(result.recorded).toBe(false);
    expect(result.reason).toBe('preview');
    expect(result.role).toBe('teacher');
  });

  it('forged studentId is not sent to server', async () => {
    enqueueResponse(200, { success: true, recorded: true });

    await recordLearningEvent({
      courseId: 'course-1',
      eventType: 'open_course',
      // @ts-expect-error 客户端不再携带 studentId，测试确保旧字段被忽略
      studentId: 'forged-student-id',
    });

    const call = fetchCalls.find((c) => c.method === 'POST' && c.url === '/api/learning/events');
    const payload = JSON.parse(call?.body ?? '{}');
    expect(payload.studentId).toBeUndefined();
  });
});
