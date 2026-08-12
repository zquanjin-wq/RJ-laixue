/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Gate 0.5: /api/learning/events identity-trust tests.
 *
 * Verifies that the endpoint resolves the learner from the authenticated
 * Supabase session, ignores any client-supplied studentId, and refuses to
 * write for unbound/disabled/unassigned learners or admin/teacher previews.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

const { getServerSupabaseMock, getServiceSupabaseMock } = vi.hoisted(() => ({
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

const USER_UNBOUND = { id: 'user-unbound' };
const USER_DISABLED = { id: 'user-disabled' };
const USER_ASSIGNED = { id: 'user-assigned' };
const USER_NO_PROFILE = { id: 'user-no-profile' };
const ADMIN = { id: 'admin-uuid' };
const TEACHER = { id: 'teacher-uuid' };

const STUDENT_ASSIGNED = { id: 'student-assigned', disabled_at: null };
const STUDENT_DISABLED = { id: 'student-disabled', disabled_at: '2026-01-01T00:00:00Z' };

const ASSIGNMENT_ASSIGNED = {
  id: 'assignment-assigned',
  course_id: 'course-1',
  student_id: STUDENT_ASSIGNED.id,
  status: 'not_started',
};

interface ServiceCall {
  table: string;
  method: 'select' | 'insert' | 'update';
  args: unknown[];
}

function makeServiceClient(opts: {
  profile?: { role: string } | null;
  student?: { id: string; disabled_at: string | null } | null;
  assignment?: typeof ASSIGNMENT_ASSIGNED | null;
  task?: {
    id: string;
    course_id: string;
    status: string;
    start_at: string | null;
    snapshot_id: string | null;
  } | null;
  snapshot?: { snapshot_data: { stage: unknown; scenes: unknown[]; outlines?: unknown[] } } | null;
  taskLearner?: { id: string; student_id: string } | null;
  insertError?: { message: string } | null;
  updateError?: { message: string } | null;
  profileError?: { message: string } | null;
  studentError?: { message: string } | null;
  assignmentError?: { message: string } | null;
}) {
  const calls: ServiceCall[] = [];
  const insertedRows: Record<string, unknown>[] = [];
  const updatedRows: Record<string, unknown>[] = [];

  function maybeSingleResult(table: string) {
    if (table === 'profiles') {
      if (opts.profileError) return { data: null, error: opts.profileError };
      return { data: opts.profile ?? null, error: null };
    }
    if (table === 'students') {
      if (opts.studentError) return { data: null, error: opts.studentError };
      return { data: opts.student ?? null, error: null };
    }
    if (table === 'course_assignments') {
      if (opts.assignmentError) return { data: null, error: opts.assignmentError };
      return { data: opts.assignment ?? null, error: null };
    }
    if (table === 'learning_tasks') {
      return { data: opts.task ?? null, error: null };
    }
    if (table === 'course_snapshots') {
      return { data: opts.snapshot ?? null, error: null };
    }
    if (table === 'task_learners') {
      return { data: opts.taskLearner ?? null, error: null };
    }
    return { data: null, error: null };
  }

  // select 链支持无限 .eq()，最后以 .maybeSingle() 终止。
  function selectChain(table: string): unknown {
    return {
      eq() {
        return selectChain(table);
      },
      maybeSingle: async () => maybeSingleResult(table),
    };
  }

  // update 链支持无限 .eq()，最后返回一个可 await 的 Promise。
  function updateChain(table: string, depth = 0): unknown {
    return {
      eq() {
        return updateChain(table, depth + 1);
      },
      then: undefined,
      catch: undefined,
      finally: undefined,
    };
  }

  const builder: any = {
    from(table: string) {
      return {
        select(...selectArgs: unknown[]) {
          calls.push({ table, method: 'select', args: selectArgs });
          return selectChain(table);
        },
        insert(row: Record<string, unknown>) {
          calls.push({ table, method: 'insert', args: [row] });
          insertedRows.push(row);
          return Promise.resolve({ error: opts.insertError ?? null });
        },
        update(row: Record<string, unknown>) {
          calls.push({ table, method: 'update', args: [row] });
          updatedRows.push(row);
          // 返回一个 thenable，连续 .eq() 最终返回 Promise
          let chain: unknown = Promise.resolve({ error: opts.updateError ?? null });
          for (let i = 0; i < 3; i++) {
            const current = chain;
            chain = {
              eq() {
                return current;
              },
            };
          }
          return chain;
        },
      };
    },
  };

  return { client: builder as unknown as SupabaseClient, calls, insertedRows, updatedRows };
}

function makeServerClient(
  user: { id: string } | null,
  authError: { message: string } | null = null,
) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: authError }),
    },
  };
}

async function postLearningEvent(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/learning/events/route');
  const req = new Request('http://localhost/api/learning/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req as unknown as NextRequest);
}

async function readJson(res: Response) {
  return res.json().catch(() => ({}));
}

describe('POST /api/learning/events identity trust', () => {
  beforeEach(() => {
    getServerSupabaseMock.mockClear();
    getServiceSupabaseMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    getServiceSupabaseMock.mockReset();
    getServerSupabaseMock.mockReset();
  });

  it('1. unauthenticated → 401 UNAUTHENTICATED, zero writes', async () => {
    getServerSupabaseMock.mockResolvedValueOnce(makeServerClient(null));

    const res = await postLearningEvent({ courseId: 'course-1', eventType: 'open_course' });
    const json = await readJson(res);

    expect(res.status).toBe(401);
    expect(json.errorCode).toBe('UNAUTHENTICATED');
    expect(getServiceSupabaseMock).not.toHaveBeenCalled();
  });

  it('2. learner with forged studentId still writes only their own record', async () => {
    getServerSupabaseMock.mockResolvedValueOnce(makeServerClient(USER_ASSIGNED));
    const { client, calls, insertedRows } = makeServiceClient({
      profile: { role: 'learner' },
      student: STUDENT_ASSIGNED,
      assignment: ASSIGNMENT_ASSIGNED,
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const res = await postLearningEvent({
      courseId: 'course-1',
      eventType: 'open_course',
      studentId: 'attacker-student-id',
    });
    const json = await readJson(res);

    expect(res.status).toBe(200);
    expect(json.recorded).toBe(true);
    expect(getServiceSupabaseMock).toHaveBeenCalled();

    const eventInsert = insertedRows[0];
    expect(eventInsert.student_id).toBe(STUDENT_ASSIGNED.id);
    expect(eventInsert.assignment_id).toBe(ASSIGNMENT_ASSIGNED.id);

    // 请求体中的 studentId 被忽略，不会进入任何查询
    const studentSelect = calls.find((c) => c.table === 'students' && c.method === 'select');
    expect(studentSelect).toBeDefined();
    const assignmentSelect = calls.find(
      (c) => c.table === 'course_assignments' && c.method === 'select',
    );
    expect(assignmentSelect).toBeDefined();
  });

  it('3. bound, enabled, assigned learner → insert event and update assignment', async () => {
    getServerSupabaseMock.mockResolvedValueOnce(makeServerClient(USER_ASSIGNED));
    const { client, insertedRows, updatedRows } = makeServiceClient({
      profile: { role: 'learner' },
      student: STUDENT_ASSIGNED,
      assignment: ASSIGNMENT_ASSIGNED,
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const res = await postLearningEvent({
      courseId: 'course-1',
      eventType: 'open_course',
      sceneId: 'scene-1',
      sceneOrder: 0,
    });
    const json = await readJson(res);

    expect(res.status).toBe(200);
    expect(json.recorded).toBe(true);

    const eventInsert = insertedRows[0];
    expect(eventInsert.course_id).toBe('course-1');
    expect(eventInsert.student_id).toBe(STUDENT_ASSIGNED.id);
    expect(eventInsert.assignment_id).toBe(ASSIGNMENT_ASSIGNED.id);
    expect(eventInsert.event_type).toBe('open_course');
    expect(eventInsert.scene_id).toBe('scene-1');
    expect(eventInsert.scene_order).toBe(0);

    const assignmentUpdate = updatedRows[0];
    expect(assignmentUpdate.status).toBe('in_progress');
    expect(assignmentUpdate.started_at).toBeTruthy();
    expect(assignmentUpdate.last_seen_at).toBeTruthy();
  });

  it('4. unbound learner → 403 LEARNER_NOT_BOUND, zero writes', async () => {
    getServerSupabaseMock.mockResolvedValueOnce(makeServerClient(USER_UNBOUND));
    const { client, insertedRows, updatedRows } = makeServiceClient({
      profile: { role: 'learner' },
      student: null,
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const res = await postLearningEvent({ courseId: 'course-1', eventType: 'open_course' });
    const json = await readJson(res);

    expect(res.status).toBe(403);
    expect(json.errorCode).toBe('LEARNER_NOT_BOUND');
    expect(insertedRows).toHaveLength(0);
    expect(updatedRows).toHaveLength(0);
  });

  it('5. disabled learner → 403 LEARNER_DISABLED, zero writes', async () => {
    getServerSupabaseMock.mockResolvedValueOnce(makeServerClient(USER_DISABLED));
    const { client, insertedRows, updatedRows } = makeServiceClient({
      profile: { role: 'learner' },
      student: STUDENT_DISABLED,
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const res = await postLearningEvent({ courseId: 'course-1', eventType: 'open_course' });
    const json = await readJson(res);

    expect(res.status).toBe(403);
    expect(json.errorCode).toBe('LEARNER_DISABLED');
    expect(insertedRows).toHaveLength(0);
    expect(updatedRows).toHaveLength(0);
  });

  it('6. learner without assignment → 403 COURSE_NOT_ASSIGNED, zero writes', async () => {
    getServerSupabaseMock.mockResolvedValueOnce(makeServerClient(USER_ASSIGNED));
    const { client, insertedRows, updatedRows } = makeServiceClient({
      profile: { role: 'learner' },
      student: STUDENT_ASSIGNED,
      assignment: null,
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const res = await postLearningEvent({ courseId: 'course-1', eventType: 'open_course' });
    const json = await readJson(res);

    expect(res.status).toBe(403);
    expect(json.errorCode).toBe('COURSE_NOT_ASSIGNED');
    expect(insertedRows).toHaveLength(0);
    expect(updatedRows).toHaveLength(0);
  });

  it('7. admin preview → 200 recorded:false, zero writes', async () => {
    getServerSupabaseMock.mockResolvedValueOnce(makeServerClient(ADMIN));
    const { client, insertedRows, updatedRows } = makeServiceClient({
      profile: { role: 'admin' },
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const res = await postLearningEvent({ courseId: 'course-1', eventType: 'open_course' });
    const json = await readJson(res);

    expect(res.status).toBe(200);
    expect(json.recorded).toBe(false);
    expect(json.reason).toBe('preview');
    expect(json.role).toBe('admin');
    expect(insertedRows).toHaveLength(0);
    expect(updatedRows).toHaveLength(0);
  });

  it('8. teacher preview → 200 recorded:false, zero writes', async () => {
    getServerSupabaseMock.mockResolvedValueOnce(makeServerClient(TEACHER));
    const { client, insertedRows, updatedRows } = makeServiceClient({
      profile: { role: 'teacher' },
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const res = await postLearningEvent({ courseId: 'course-1', eventType: 'complete_course' });
    const json = await readJson(res);

    expect(res.status).toBe(200);
    expect(json.recorded).toBe(false);
    expect(json.reason).toBe('preview');
    expect(json.role).toBe('teacher');
    expect(insertedRows).toHaveLength(0);
    expect(updatedRows).toHaveLength(0);
  });

  it('9. learner with no profile row falls back to learner rules (bound+assigned)', async () => {
    getServerSupabaseMock.mockResolvedValueOnce(makeServerClient(USER_NO_PROFILE));
    const { client, insertedRows } = makeServiceClient({
      profile: null,
      student: STUDENT_ASSIGNED,
      assignment: ASSIGNMENT_ASSIGNED,
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const res = await postLearningEvent({ courseId: 'course-1', eventType: 'open_course' });
    const json = await readJson(res);

    expect(res.status).toBe(200);
    expect(json.recorded).toBe(true);
    expect(insertedRows[0].student_id).toBe(STUDENT_ASSIGNED.id);
  });

  it('10. invalid courseId or eventType → 400, no identity/database writes', async () => {
    getServerSupabaseMock.mockResolvedValueOnce(makeServerClient(USER_ASSIGNED));

    const missingCourse = await postLearningEvent({ eventType: 'open_course' });
    expect(missingCourse.status).toBe(400);
    expect(getServiceSupabaseMock).not.toHaveBeenCalled();

    const invalidEvent = await postLearningEvent({ courseId: 'course-1', eventType: 'fake_event' });
    expect(invalidEvent.status).toBe(400);
  });

  it('11. database error → 500 without leaking service-role details', async () => {
    getServerSupabaseMock.mockResolvedValueOnce(makeServerClient(USER_ASSIGNED));
    const { client } = makeServiceClient({
      profile: { role: 'learner' },
      student: STUDENT_ASSIGNED,
      assignment: ASSIGNMENT_ASSIGNED,
      insertError: { message: 'connection reset by peer' },
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const res = await postLearningEvent({ courseId: 'course-1', eventType: 'open_course' });
    const json = await readJson(res);

    expect(res.status).toBe(500);
    expect(json.errorCode).toBe('WRITE_FAILED');
    expect(json.error).not.toContain('connection reset by peer');
    expect(json.error).not.toContain('service_role');
  });

  it('12. complete_course only updates the resolved assignment', async () => {
    getServerSupabaseMock.mockResolvedValueOnce(makeServerClient(USER_ASSIGNED));
    const { client, updatedRows } = makeServiceClient({
      profile: { role: 'learner' },
      student: STUDENT_ASSIGNED,
      assignment: ASSIGNMENT_ASSIGNED,
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const res = await postLearningEvent({ courseId: 'course-1', eventType: 'complete_course' });
    const json = await readJson(res);

    expect(res.status).toBe(200);
    expect(json.recorded).toBe(true);

    const assignmentUpdate = updatedRows[0];
    expect(assignmentUpdate.status).toBe('completed');
    expect(assignmentUpdate.completed_at).toBeTruthy();
  });

  it('13. session missing auth error → 401 UNAUTHENTICATED, zero writes', async () => {
    const sessionMissingError = Object.assign(
      new Error('Auth session missing!'), // Supabase @supabase/ssr 常见 message
      { name: 'AuthSessionMissingError' },
    );
    getServerSupabaseMock.mockResolvedValueOnce(
      makeServerClient(USER_ASSIGNED, sessionMissingError),
    );

    const res = await postLearningEvent({ courseId: 'course-1', eventType: 'open_course' });
    const json = await readJson(res);

    expect(res.status).toBe(401);
    expect(json.errorCode).toBe('UNAUTHENTICATED');
    expect(json.error).toBe('未登录');
    expect(getServiceSupabaseMock).not.toHaveBeenCalled();
  });

  it('15. task context → recorded:false pending, no course_assignments fallback', async () => {
    getServerSupabaseMock.mockResolvedValueOnce(makeServerClient(USER_ASSIGNED));
    const { client, calls, insertedRows, updatedRows } = makeServiceClient({
      profile: { role: 'learner' },
      student: STUDENT_ASSIGNED,
      task: {
        id: 'task-1',
        course_id: 'course-1',
        status: 'published',
        start_at: null,
        snapshot_id: 'snap-1',
      },
      snapshot: {
        snapshot_data: {
          stage: { id: 'stage-1', name: 'S' },
          scenes: [{ id: 'scene-1', title: 'Scene 1' }],
        },
      },
      taskLearner: { id: 'tl-1', student_id: STUDENT_ASSIGNED.id },
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const res = await postLearningEvent({
      courseId: 'course-1',
      eventType: 'open_course',
      taskId: 'task-1',
    });
    const json = await readJson(res);

    expect(res.status).toBe(200);
    expect(json.recorded).toBe(false);
    expect(json.reason).toBe('task_event_collection_pending');
    expect(json.actor).toBe('learner');
    expect(insertedRows).toHaveLength(0);
    expect(updatedRows).toHaveLength(0);

    // 校验身份时查询了 task_learners，但没有走 course_assignments
    const assignmentSelect = calls.find(
      (c) => c.table === 'course_assignments' && c.method === 'select',
    );
    expect(assignmentSelect).toBeUndefined();
  });

  it('16. task context with non-assigned learner → 403 LEARNER_NOT_ASSIGNED', async () => {
    getServerSupabaseMock.mockResolvedValueOnce(makeServerClient(USER_UNBOUND));
    const { client, insertedRows, updatedRows } = makeServiceClient({
      profile: { role: 'learner' },
      student: null,
      task: {
        id: 'task-1',
        course_id: 'course-1',
        status: 'published',
        start_at: null,
        snapshot_id: 'snap-1',
      },
      snapshot: {
        snapshot_data: {
          stage: { id: 'stage-1', name: 'S' },
          scenes: [{ id: 'scene-1', title: 'Scene 1' }],
        },
      },
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const res = await postLearningEvent({
      courseId: 'course-1',
      eventType: 'open_course',
      taskId: 'task-1',
    });
    const json = await readJson(res);

    expect(res.status).toBe(403);
    expect(json.errorCode).toBe('LEARNER_NOT_BOUND');
    expect(insertedRows).toHaveLength(0);
    expect(updatedRows).toHaveLength(0);
  });

  it('17. task context admin preview → recorded:false pending', async () => {
    getServerSupabaseMock.mockResolvedValueOnce(makeServerClient(ADMIN));
    const { client, insertedRows, updatedRows } = makeServiceClient({
      profile: { role: 'admin' },
      task: {
        id: 'task-1',
        course_id: 'course-1',
        status: 'published',
        start_at: null,
        snapshot_id: 'snap-1',
      },
      snapshot: {
        snapshot_data: {
          stage: { id: 'stage-1', name: 'S' },
          scenes: [{ id: 'scene-1', title: 'Scene 1' }],
        },
      },
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const res = await postLearningEvent({
      courseId: 'course-1',
      eventType: 'open_course',
      taskId: 'task-1',
    });
    const json = await readJson(res);

    expect(res.status).toBe(200);
    expect(json.recorded).toBe(false);
    expect(json.reason).toBe('task_event_collection_pending');
    expect(json.actor).toBe('preview');
    expect(insertedRows).toHaveLength(0);
    expect(updatedRows).toHaveLength(0);
  });

  it('14. message-based session missing → 401 UNAUTHENTICATED', async () => {
    const sessionMissingError = new Error('session_not_found: no session in cookie');
    getServerSupabaseMock.mockResolvedValueOnce(
      makeServerClient(USER_ASSIGNED, sessionMissingError),
    );

    const res = await postLearningEvent({ courseId: 'course-1', eventType: 'open_course' });
    const json = await readJson(res);

    expect(res.status).toBe(401);
    expect(json.errorCode).toBe('UNAUTHENTICATED');
    expect(getServiceSupabaseMock).not.toHaveBeenCalled();
  });
});
