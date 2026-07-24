/**
 * Authorization tests for POST /api/courses upsert.
 *
 * The route uses service_role to upsert, which bypasses RLS entirely.
 * Without an explicit ownership gate, any signed-in user could POST a
 * course id they don't own and overwrite it (or even hijack the
 * created_by field via the upsert payload). These tests pin the
 * authorization contract added in 2026-07-24.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

type CourseRow = { id: string; created_by: string } | null;

// We mock both client factories. Each test rebuilds the mock to control
// the exact sequence of queries the route performs:
//   1. auth.getUser() → returns caller (serverSupabase)
//   2. .from('courses').select('created_by').eq('id', id).maybeSingle()
//   3. (if existing) .from('profiles').select('role').eq('id', user.id).maybeSingle()
//   4. .from('courses').upsert(...)
const { getServerSupabaseMock, getServiceSupabaseMock } = vi.hoisted(() => {
  const serverQueryResult = { data: { user: null as null | { id: string } }, error: null };
  const getServerSupabase = vi.fn(async () => ({
    auth: {
      getUser: vi.fn().mockResolvedValue(serverQueryResult),
    },
  }));
  const getServiceSupabase = vi.fn();
  return { getServerSupabaseMock: getServerSupabase, getServiceSupabaseMock: getServiceSupabase };
});

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

// Helper: build a chained Supabase client that always returns the
// provided maybeSingle / upsert results, in order. The route calls
//   a) .from('courses').select(...).eq(...).maybeSingle()
//   b) .from('profiles').select('role').eq(...).maybeSingle()  (only if a returned a row)
//   c) .from('courses').upsert(...)
function makeServiceClient(opts: {
  caller: { id: string };
  existingCourse: CourseRow;
  callerProfile: { role: string } | null;
  upsertError?: { message: string } | null;
  upsertSpy?: (row: unknown) => void;
}) {
  const calls: string[] = [];
  const builder: any = {
    from(table: string) {
      calls.push(`from:${table}`);
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => {
                  if (table === 'courses') {
                    return { data: opts.existingCourse, error: null };
                  }
                  if (table === 'profiles') {
                    return { data: opts.callerProfile, error: null };
                  }
                  return { data: null, error: null };
                },
              };
            },
          };
        },
        upsert(row: unknown) {
          calls.push(`upsert:${table}`);
          opts.upsertSpy?.(row);
          return Promise.resolve({ error: opts.upsertError ?? null });
        },
      };
    },
  };
  return { client: builder, calls };
}

async function postCourses(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/courses/route');
  const req = new Request('http://localhost/api/courses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req as unknown as NextRequest);
}

const USER_A = { id: 'user-a-uuid' };
const USER_B = { id: 'user-b-uuid' };
const ADMIN = { id: 'admin-uuid' };
const COURSE_A_OWNED = { id: 'course-1', created_by: USER_A.id };

describe('POST /api/courses authorization', () => {
  beforeEach(() => {
    // Note: do NOT vi.resetModules() here — that would re-import the
    // route module mid-test, which re-runs module-level code and can
    // re-consume a mockReturnValue intended for the test body.
    // Instead, just clear mock history.
    getServerSupabaseMock.mockClear();
    getServiceSupabaseMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Reset to a no-op default so a test that doesn't set its own mock
    // does not inherit the previous test's mockReturnValue.
    getServiceSupabaseMock.mockReset();
    getServerSupabaseMock.mockReset();
  });

  it('1. unauthenticated caller → 401', async () => {
    // getServerSupabase returns no user
    getServerSupabaseMock.mockResolvedValueOnce({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }) },
    });
    const res = await postCourses({ id: 'c1', data: { stage: { name: 'x' } } });
    expect(res.status).toBe(401);
  });

  it('2. teacher A saves own course → 200, upsert called with created_by', async () => {
    getServerSupabaseMock.mockResolvedValueOnce({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: USER_A }, error: null }) },
    });
    const upsertSpy = vi.fn();
    const { client } = makeServiceClient({
      caller: USER_A,
      existingCourse: null, // new INSERT
      callerProfile: null,
      upsertSpy,
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const res = await postCourses({
      id: 'new-course',
      title: 'My course',
      data: { stage: { name: 's' } },
    });
    expect(res.status).toBe(200);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    // On INSERT (no existing row), the new course must attribute
    // ownership to the caller.
    const payload = upsertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.created_by).toBe(USER_A.id);
    expect(payload.id).toBe('new-course');
  });

  it('3. teacher B tries to save A-owned course → 403, no upsert', async () => {
    getServerSupabaseMock.mockResolvedValueOnce({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: USER_B }, error: null }) },
    });
    const upsertSpy = vi.fn();
    const { client } = makeServiceClient({
      caller: USER_B,
      existingCourse: COURSE_A_OWNED, // owned by A
      callerProfile: { role: 'teacher' },
      upsertSpy,
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const res = await postCourses({
      id: 'course-1',
      title: 'Hijack attempt',
      data: { stage: { name: 's' } },
    });
    expect(res.status).toBe(403);
    // Critically: the upsert must NEVER have been called.
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('4. teacher A updates own course → 200, upsert called WITHOUT created_by', async () => {
    getServerSupabaseMock.mockResolvedValueOnce({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: USER_A }, error: null }) },
    });
    const upsertSpy = vi.fn();
    const { client, calls } = makeServiceClient({
      caller: USER_A,
      existingCourse: COURSE_A_OWNED, // owned by A → UPDATE
      callerProfile: null,
      upsertSpy,
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const res = await postCourses({
      id: 'course-1',
      title: 'Updated title',
      data: { stage: { name: 's' } },
    });
    expect(res.status).toBe(200);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    // The fix: created_by must NOT be in the upsert payload when the
    // course already exists, even for the rightful owner. This prevents
    // both accidental overwrite (null if the route used partial updates)
    // and the silent ownership-hijack pattern.
    const payload = upsertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('created_by');
    expect(payload.id).toBe('course-1');
    expect(payload.title).toBe('Updated title');
  });

  it('5. admin can update any course (cross-owner admin save) → 200', async () => {
    getServerSupabaseMock.mockResolvedValueOnce({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: ADMIN }, error: null }) },
    });
    const upsertSpy = vi.fn();
    const { client } = makeServiceClient({
      caller: ADMIN,
      existingCourse: COURSE_A_OWNED, // owned by A, not by admin
      callerProfile: { role: 'admin' },
      upsertSpy,
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const res = await postCourses({
      id: 'course-1',
      title: 'Admin override',
      data: { stage: { name: 's' } },
    });
    expect(res.status).toBe(200);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    // Admin update preserves the original created_by — admin does not
    // become the new owner, they just have override write access.
    const payload = upsertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('created_by');
    expect(payload.title).toBe('Admin override');
  });

  it('6. malicious body trying to set created_by is dropped on UPDATE', async () => {
    // Even if a future caller tries to inject created_by into the body,
    // the route only reads { id, title, topic, data } — created_by is
    // never a body field. This is enforced by the destructuring at the
    // top of POST. We pin that contract here.
    getServerSupabaseMock.mockResolvedValueOnce({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: USER_A }, error: null }) },
    });
    const upsertSpy = vi.fn();
    const { client } = makeServiceClient({
      caller: USER_A,
      existingCourse: COURSE_A_OWNED,
      callerProfile: null,
      upsertSpy,
    });
    getServiceSupabaseMock.mockReturnValue(client);

    await postCourses({
      id: 'course-1',
      title: 't',
      data: { stage: { name: 's' } },
      // attacker tries to inject created_by into the body
      ...({ created_by: 'attacker-uuid' } as Record<string, unknown>),
    });
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const payload = upsertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.created_by).toBeUndefined();
  });
});
