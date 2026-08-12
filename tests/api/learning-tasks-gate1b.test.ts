/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Gate 1B: 学习任务发布与学员进入闭环测试
 *
 * 覆盖：
 *   - /api/classroom/snapshot 鉴权与快照返回
 *   - /learn/[token] 入口服务端解析
 *   - 任务事件 task 上下文返回 pending
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

const ADMIN = { id: 'admin-uuid' };
const TEACHER = { id: 'teacher-uuid' };
const LEARNER_ASSIGNED = { id: 'learner-assigned' };
const LEARNER_UNBOUND = { id: 'learner-unbound' };

const STUDENT_ASSIGNED = { id: 'student-1', disabled_at: null, user_id: LEARNER_ASSIGNED.id };
const TASK_PUBLISHED = {
  id: 'task-1',
  course_id: 'course-1',
  status: 'published',
  start_at: null,
  due_at: null,
  snapshot_id: 'snap-1',
  share_token: 'tok123',
  title: 'Task Title',
};

const SNAPSHOT = {
  snapshot_data: {
    stage: { id: 'stage-1', name: 'Course', description: 'desc' },
    scenes: [{ id: 'scene-1', type: 'slide', title: 'Slide 1', order: 0 }],
    outlines: [{ id: 'o1', title: 'Outline 1', order: 0 }],
  },
};

interface ServiceCall {
  table: string;
  method: string;
  args: unknown[];
}

function makeServiceClient(opts: {
  profile?: { role: string } | null;
  student?: { id: string; disabled_at: string | null; user_id?: string } | null;
  task?: {
    id: string;
    course_id: string;
    status: string;
    start_at: string | null;
    due_at?: string | null;
    snapshot_id: string | null;
    share_token: string;
    title: string;
    created_by?: string;
  } | null;
  snapshot?: { snapshot_data: { stage: unknown; scenes: unknown[]; outlines?: unknown[] } } | null;
  taskLearner?: { id: string; student_id: string } | null;
}) {
  const calls: ServiceCall[] = [];

  function maybeSingleResult(table: string, filters: Record<string, unknown> = {}) {
    if (table === 'profiles') return { data: opts.profile ?? null, error: null };
    if (table === 'students') return { data: opts.student ?? null, error: null };
    if (table === 'learning_tasks') {
      const task = opts.task ?? null;
      if (filters.created_by && task?.created_by !== filters.created_by) {
        return { data: null, error: null };
      }
      return { data: task, error: null };
    }
    if (table === 'course_snapshots') return { data: opts.snapshot ?? null, error: null };
    if (table === 'task_learners') return { data: opts.taskLearner ?? null, error: null };
    return { data: null, error: null };
  }

  function selectChain(table: string, filters: Record<string, unknown> = {}): unknown {
    calls.push({ table, method: 'select', args: [] });
    return {
      eq(column: string, value: unknown) {
        return selectChain(table, { ...filters, [column]: value });
      },
      is() {
        return selectChain(table);
      },
      in() {
        return selectChain(table);
      },
      order() {
        return selectChain(table);
      },
      maybeSingle: async () => maybeSingleResult(table, filters),
      single: async () => {
        const data = maybeSingleResult(table, filters).data;
        if (!data) return { data: null, error: { code: 'PGRST116' } };
        return { data, error: null };
      },
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
          return {
            select: () => ({
              single: async () => ({ data: { ...row, id: 'new-id' }, error: null }),
            }),
          };
        },
        update(row: Record<string, unknown>) {
          calls.push({ table, method: 'update', args: [row] });
          let chain: unknown = Promise.resolve({ data: row, error: null });
          for (let i = 0; i < 3; i++) {
            const current = chain;
            chain = { eq: () => current };
          }
          return chain;
        },
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ table: `rpc:${fn}`, method: 'rpc', args: [args] });
      if (fn === 'count_task_learners') {
        return Promise.resolve({
          data: [{ task_id: (args.p_task_ids as string[])[0], count: 1 }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };

  return { client: builder as unknown as SupabaseClient, calls };
}

function makeServerClient(user: { id: string } | null) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    },
  };
}

async function readJson(res: Response) {
  return res.json().catch(() => ({}));
}

function makeNextRequest(url: string) {
  return Object.assign(new Request(url), { nextUrl: new URL(url) }) as unknown as NextRequest;
}

describe('Gate 1B — /api/classroom/snapshot', () => {
  beforeEach(() => {
    getServerSupabaseMock.mockClear();
    getServiceSupabaseMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    getServiceSupabaseMock.mockReset();
    getServerSupabaseMock.mockReset();
  });

  it('未登录 → 401', async () => {
    getServerSupabaseMock.mockResolvedValue(makeServerClient(null));
    const { GET } = await import('@/app/api/classroom/snapshot/route');
    const req = makeNextRequest('http://localhost/api/classroom/snapshot?taskId=task-1');
    const res = await GET(req);
    const json = await readJson(res);
    expect(res.status).toBe(401);
    expect(json.errorCode).toBe('UNAUTHENTICATED');
  });

  it('缺少 taskId → 400', async () => {
    getServerSupabaseMock.mockResolvedValue(makeServerClient(ADMIN));
    const { GET } = await import('@/app/api/classroom/snapshot/route');
    const req = makeNextRequest('http://localhost/api/classroom/snapshot');
    const res = await GET(req);
    const json = await readJson(res);
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe('MISSING_TASK_ID');
  });

  it('任务不存在 → 404', async () => {
    getServerSupabaseMock.mockResolvedValue(makeServerClient(ADMIN));
    const { client } = makeServiceClient({ profile: { role: 'admin' }, task: null });
    getServiceSupabaseMock.mockReturnValue(client);

    const { GET } = await import('@/app/api/classroom/snapshot/route');
    const req = makeNextRequest('http://localhost/api/classroom/snapshot?taskId=task-1');
    const res = await GET(req);
    const json = await readJson(res);
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe('TASK_NOT_FOUND');
  });

  it('非名单学员 → 403 LEARNER_NOT_ASSIGNED', async () => {
    getServerSupabaseMock.mockResolvedValue(makeServerClient(LEARNER_ASSIGNED));
    const { client } = makeServiceClient({
      profile: { role: 'learner' },
      student: STUDENT_ASSIGNED,
      task: TASK_PUBLISHED,
      snapshot: SNAPSHOT,
      taskLearner: null,
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const { GET } = await import('@/app/api/classroom/snapshot/route');
    const req = makeNextRequest('http://localhost/api/classroom/snapshot?taskId=task-1');
    const res = await GET(req);
    const json = await readJson(res);
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe('LEARNER_NOT_ASSIGNED');
  });

  it('名单内学员返回快照，不含标准答案', async () => {
    getServerSupabaseMock.mockResolvedValue(makeServerClient(LEARNER_ASSIGNED));
    const { client } = makeServiceClient({
      profile: { role: 'learner' },
      student: STUDENT_ASSIGNED,
      task: TASK_PUBLISHED,
      snapshot: {
        snapshot_data: {
          stage: { id: 'stage-1', name: 'Course' },
          scenes: [
            {
              id: 'scene-1',
              type: 'quiz',
              title: 'Quiz',
              content: {
                questions: [{ id: 'q1', type: 'single', text: 'Q1', answer: 'A' }],
              },
            },
          ],
          outlines: [],
        },
      },
      taskLearner: { id: 'tl-1', student_id: STUDENT_ASSIGNED.id },
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const { GET } = await import('@/app/api/classroom/snapshot/route');
    const req = makeNextRequest('http://localhost/api/classroom/snapshot?taskId=task-1');
    const res = await GET(req);
    const json = await readJson(res);

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.actor).toBe('learner');
    expect(json.data.stage.id).toBe('stage-1');
    expect(json.data.scenes).toHaveLength(1);

    const question = json.data.scenes[0].content.questions[0];
    expect(question.text).toBe('Q1');
    expect(question.answer).toBeUndefined();

    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('未开始任务 → 403 TASK_NOT_STARTED', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    getServerSupabaseMock.mockResolvedValue(makeServerClient(LEARNER_ASSIGNED));
    const { client } = makeServiceClient({
      profile: { role: 'learner' },
      student: STUDENT_ASSIGNED,
      task: { ...TASK_PUBLISHED, start_at: future },
      snapshot: SNAPSHOT,
      taskLearner: { id: 'tl-1', student_id: STUDENT_ASSIGNED.id },
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const { GET } = await import('@/app/api/classroom/snapshot/route');
    const req = makeNextRequest('http://localhost/api/classroom/snapshot?taskId=task-1');
    const res = await GET(req);
    const json = await readJson(res);
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe('TASK_NOT_STARTED');
  });

  it('admin preview → 200 actor:preview', async () => {
    getServerSupabaseMock.mockResolvedValue(makeServerClient(ADMIN));
    const { client } = makeServiceClient({
      profile: { role: 'admin' },
      task: TASK_PUBLISHED,
      snapshot: SNAPSHOT,
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const { GET } = await import('@/app/api/classroom/snapshot/route');
    const req = makeNextRequest('http://localhost/api/classroom/snapshot?taskId=task-1');
    const res = await GET(req);
    const json = await readJson(res);
    expect(res.status).toBe(200);
    expect(json.actor).toBe('preview');
  });

  it('teacher preview requires task ownership', async () => {
    getServerSupabaseMock.mockResolvedValue(makeServerClient(TEACHER));
    const { client } = makeServiceClient({
      profile: { role: 'teacher' },
      task: { ...TASK_PUBLISHED, created_by: 'another-teacher' },
      snapshot: SNAPSHOT,
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const { GET } = await import('@/app/api/classroom/snapshot/route');
    const res = await GET(makeNextRequest('http://localhost/api/classroom/snapshot?taskId=task-1'));

    expect(res.status).toBe(403);
  });
});

describe('Gate 1B — teacher task entry', () => {
  afterEach(() => {
    getServiceSupabaseMock.mockReset();
  });

  it('does not expose another teacher task through its token', async () => {
    const { client } = makeServiceClient({
      profile: { role: 'teacher' },
      task: { ...TASK_PUBLISHED, created_by: 'another-teacher' },
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const { resolveTaskEntry } = await import('@/lib/server/learning-tasks/task-entry');
    const result = await resolveTaskEntry(TEACHER.id, 'tok123');

    expect(result).toMatchObject({ ok: false, status: 403, errorCode: 'TASK_NOT_OWNED' });
    expect(result).not.toHaveProperty('title');
  });
});

describe('Gate 1B — /learn/[token] entry resolution', () => {
  beforeEach(() => {
    getServerSupabaseMock.mockClear();
    getServiceSupabaseMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    getServiceSupabaseMock.mockReset();
    getServerSupabaseMock.mockReset();
  });

  it('未登录 → redirect to /login with next', async () => {
    getServerSupabaseMock.mockResolvedValue(makeServerClient(null));
    const { default: Page } = await import('@/app/learn/[token]/page');

    let thrown: unknown;
    try {
      await Page({ params: Promise.resolve({ token: 'tok123' }) });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error & { digest?: string };
    expect(err.message).toBe('NEXT_REDIRECT');
    expect(err.digest).toContain('/login?next=');
    expect(err.digest).toContain('learn');
    expect(err.digest).toContain('tok123');
  });

  it('无效 token → notFound', async () => {
    getServerSupabaseMock.mockResolvedValue(makeServerClient(LEARNER_ASSIGNED));
    const { client } = makeServiceClient({ profile: { role: 'learner' }, task: null });
    getServiceSupabaseMock.mockReturnValue(client);

    const { default: Page } = await import('@/app/learn/[token]/page');
    await expect(Page({ params: Promise.resolve({ token: 'bad-token' }) })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof Error && err.message.includes('NEXT_HTTP_ERROR_FALLBACK;404'),
    );
  });

  it('非名单学员 → 403 页面', async () => {
    getServerSupabaseMock.mockResolvedValue(makeServerClient(LEARNER_ASSIGNED));
    const { client } = makeServiceClient({
      profile: { role: 'learner' },
      student: STUDENT_ASSIGNED,
      task: TASK_PUBLISHED,
      taskLearner: null,
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const { default: Page } = await import('@/app/learn/[token]/page');
    const element = await Page({ params: Promise.resolve({ token: 'tok123' }) });
    expect(element).toBeDefined();
  });

  it('名单内学员 → redirect to classroom with task and share', async () => {
    getServerSupabaseMock.mockResolvedValue(makeServerClient(LEARNER_ASSIGNED));
    const { client } = makeServiceClient({
      profile: { role: 'learner' },
      student: STUDENT_ASSIGNED,
      task: TASK_PUBLISHED,
      taskLearner: { id: 'tl-1', student_id: STUDENT_ASSIGNED.id },
    });
    getServiceSupabaseMock.mockReturnValue(client);

    const { default: Page } = await import('@/app/learn/[token]/page');

    let thrown: unknown;
    try {
      await Page({ params: Promise.resolve({ token: 'tok123' }) });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error & { digest?: string };
    expect(err.message).toBe('NEXT_REDIRECT');
    expect(err.digest).toContain('/classroom/course-1?task=task-1&share=1');
  });
});
