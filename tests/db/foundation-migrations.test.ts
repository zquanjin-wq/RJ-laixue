import { execFile, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { migrateDatabase } from '@/lib/server/db/migrate';
import { CourseRepository } from '@/lib/server/db/course-repository';
import { AccessRepository } from '@/lib/server/db/access-repository';
import { JobRepository } from '@/lib/server/db/job-repository';
import { LearningRepository } from '@/lib/server/db/learning-repository';
import { TaskRepository } from '@/lib/server/db/task-repository';
import { PeopleRepository } from '@/lib/server/db/people-repository';
import { RuntimeStorePg } from '@/lib/server/runtime-store/pg';
import { createNodePgRuntimeClient } from '@/lib/server/runtime-store/node-pg-rpc';

const port = 55441;
let databaseDir: string;
let postgresBinDir: string;
let pool: Pool;

beforeAll(async () => {
  databaseDir = await mkdtemp(join(tmpdir(), 'laixue-p1a-data-'));
  postgresBinDir = await mkdtemp(join(tmpdir(), 'laixue-p1a-bin-'));

  const require = createRequire(import.meta.url);
  const embeddedMain = require.resolve('embedded-postgres');
  const nativeDir = join(
    dirname(embeddedMain),
    '..',
    '..',
    '@embedded-postgres',
    'windows-x64',
    'native',
  );
  if (!existsSync(join(postgresBinDir, 'bin', 'postgres.exe'))) {
    await cp(nativeDir, postgresBinDir, { recursive: true });
  }

  await promisify(execFile)(join(postgresBinDir, 'bin', 'initdb.exe'), [
    '-D',
    databaseDir,
    '-U',
    'postgres',
    '--no-locale',
    '-E',
    'UTF8',
    '-A',
    'trust',
  ]);
  writeFileSync(
    join(databaseDir, 'pg_hba.conf'),
    'host all all 127.0.0.1/32 trust\nlocal all all trust\n',
  );
  spawn(
    join(postgresBinDir, 'bin', 'postgres.exe'),
    ['-D', databaseDir, '-p', String(port), '-h', '127.0.0.1'],
    {
      stdio: 'ignore',
    },
  );

  const connectionString = `postgres://postgres@127.0.0.1:${port}/postgres`;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const probe = new Pool({ connectionString, max: 1 });
      await probe.query('select 1');
      await probe.end();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  pool = new Pool({ connectionString });
}, 30_000);

afterAll(async () => {
  await pool?.end();
  await promisify(execFile)(join(postgresBinDir, 'bin', 'pg_ctl.exe'), [
    'stop',
    '-D',
    databaseDir,
    '-m',
    'fast',
    '-w',
  ]).catch(() => undefined);
  await rm(databaseDir, { recursive: true, force: true });
  await rm(postgresBinDir, { recursive: true, force: true });
});

describe('P1 PostgreSQL foundation', () => {
  it('initializes an empty PostgreSQL database and skips completed migrations', async () => {
    const first = await migrateDatabase(pool);
    const second = await migrateDatabase(pool);

    expect(first.applied).toEqual([
      '0001_auth_foundation.sql',
      '0002_app_foundation.sql',
      '0003_courses_and_assets.sql',
      '0004_learning_tasks.sql',
      '0005_learning_activity.sql',
      '0006_jobs_and_usage.sql',
      '0007_runtime_store.sql',
    ]);
    expect(second.skipped).toEqual(first.applied);

    await pool.query(`
      INSERT INTO public."user"
        (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES ('user-1', '测试学员', 'learner@laixue.online', false, now(), now())
    `);
    await pool.query(`
      INSERT INTO app.user_profiles (user_id, role, display_name, employee_no)
      VALUES ('user-1', 'learner', '测试学员', 'LX-001')
    `);

    const profile = await pool.query<{ role: string }>(
      `SELECT role FROM app.user_profiles WHERE user_id = 'user-1'`,
    );
    expect(profile.rows[0]?.role).toBe('learner');
  });

  it('saves courses by revision and creates reusable publication snapshots', async () => {
    const courses = new CourseRepository(pool);
    const created = await courses.createCourse({
      id: 'course-1',
      ownerUserId: 'user-1',
      title: '新员工入职',
      topic: '入职培训',
      content: { scenes: [{ id: 'scene-1', title: '欢迎' }] },
    });
    expect(created.contentRevision).toBe(1);

    const updated = await courses.updateCourse({
      id: 'course-1',
      ownerUserId: 'user-1',
      expectedRevision: 1,
      title: '新员工入职指南',
      topic: '入职培训',
      content: { scenes: [{ id: 'scene-1', title: '欢迎加入' }] },
      saveState: 'ready',
    });
    expect(updated?.contentRevision).toBe(2);

    const staleUpdate = await courses.updateCourse({
      id: 'course-1',
      ownerUserId: 'user-1',
      expectedRevision: 1,
      title: '过期编辑',
      content: {},
      saveState: 'draft',
    });
    expect(staleUpdate).toBeNull();

    const asset = await courses.createAsset({
      ownerUserId: 'user-1',
      courseId: 'course-1',
      kind: 'audio',
      objectKey: 'courses/course-1/audio/welcome.mp3',
      contentType: 'audio/mpeg',
      sizeBytes: 1024,
    });
    expect(asset.state).toBe('ready');

    const firstSnapshot = await courses.createSnapshot('course-1', 'user-1');
    const repeatedSnapshot = await courses.createSnapshot('course-1', 'user-1');
    expect(firstSnapshot?.courseRevision).toBe(2);
    expect(repeatedSnapshot?.id).toBe(firstSnapshot?.id);
    expect(firstSnapshot?.content).toEqual({ scenes: [{ id: 'scene-1', title: '欢迎加入' }] });

    expect(await courses.softDeleteCourse('course-1', 'user-1')).toBe(true);
    expect(await courses.getCourse('course-1')).toBeNull();
  });

  it('publishes a task and records learning activity once', async () => {
    const courses = new CourseRepository(pool);
    await courses.createCourse({
      id: 'course-2',
      ownerUserId: 'user-1',
      title: '服务流程',
      content: { scenes: [{ id: 'scene-a' }] },
      saveState: 'ready',
    });

    const tasks = new TaskRepository(pool);
    const taskId = await tasks.createTask({
      title: '服务流程学习任务',
      createdBy: 'user-1',
      courses: [{ courseId: 'course-2' }],
      userIds: ['user-1'],
    });
    const published = await tasks.publishTask(taskId, 'user-1');
    const repeatedPublish = await tasks.publishTask(taskId, 'user-1');
    expect(repeatedPublish.shareToken).toBe(published.shareToken);

    const progressRows = await pool.query(
      `SELECT 1 FROM app.task_course_progress WHERE task_id = $1 AND user_id = 'user-1'`,
      [taskId],
    );
    expect(progressRows.rowCount).toBe(1);

    const learning = new LearningRepository(pool);
    const attemptId = await learning.startAttempt({
      taskId,
      userId: 'user-1',
      courseId: 'course-2',
      sessionKey: 'session-1',
    });
    const event = {
      attemptId,
      taskId,
      userId: 'user-1',
      courseId: 'course-2',
      clientEventId: 'event-1',
      eventType: 'scene_viewed',
      sceneId: 'scene-a',
      occurredAt: new Date(),
      effectiveSecondsDelta: 12,
      progressPercent: 50,
    };
    expect(await learning.recordEvent(event)).toBe(true);
    expect(await learning.recordEvent(event)).toBe(false);

    const assignment = await pool.query<{ effectiveSeconds: string; progressPercent: string }>(
      `SELECT effective_seconds AS "effectiveSeconds", progress_percent AS "progressPercent"
       FROM app.task_assignments WHERE task_id = $1 AND user_id = 'user-1'`,
      [taskId],
    );
    expect(assignment.rows[0]).toMatchObject({ effectiveSeconds: '12', progressPercent: '50.00' });
  });

  it('returns one result when the same task is published concurrently', async () => {
    const tasks = new TaskRepository(pool);
    const taskId = await tasks.createTask({
      title: '并发发布任务',
      createdBy: 'user-1',
      courses: [{ courseId: 'course-2' }],
      userIds: ['user-1'],
    });
    const [left, right] = await Promise.all([
      tasks.publishTask(taskId, 'user-1'),
      tasks.publishTask(taskId, 'user-1'),
    ]);
    expect(left.shareToken).toBe(right.shareToken);
  });

  it('claims one background job and stores usage idempotently', async () => {
    const jobs = new JobRepository(pool);
    const jobId = await jobs.enqueue({
      type: 'course-audio',
      ownerUserId: 'user-1',
      payload: { courseId: 'course-2' },
    });
    const claimed = await jobs.claimNext('worker-1', 'course-audio');
    expect(claimed?.id).toBe(jobId);
    expect(await jobs.claimNext('worker-2', 'course-audio')).toBeNull();
    await jobs.succeed(jobId, { objectCount: 1 });

    const usage = {
      eventKey: 'usage-1',
      userId: 'user-1',
      kind: 'model_tokens',
      source: 'course-generation',
      inputTokens: 10,
      outputTokens: 20,
    };
    expect(await jobs.recordUsage(usage)).toBe(true);
    expect(await jobs.recordUsage(usage)).toBe(false);
  });

  it('runs RuntimeStore through the ordinary PostgreSQL adapter', async () => {
    const store = new RuntimeStorePg(createNodePgRuntimeClient(pool));
    await store.createSession({
      id: 'runtime-session-1',
      kind: 'chat',
      stageId: 'course-2',
      learnerKey: 'user-1',
      status: 'active',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    const record = {
      id: 'runtime-record-1',
      sessionId: 'runtime-session-1',
      createdAt: '2026-09-01T00:01:00.000Z',
      payload: { role: 'user', content: '开始学习' },
    };
    const first = await store.appendRecord(record);
    const replay = await store.appendRecord(record);
    expect(first.seq).toBe(0);
    expect(replay).toEqual(first);
    expect(await store.listRecords('runtime-session-1')).toHaveLength(1);
  });

  it('resolves the database actor and applies the core access boundaries', async () => {
    const access = new AccessRepository(pool);
    const actor = await access.resolveActor('user-1');
    expect(actor).toEqual({ userId: 'user-1', role: 'learner' });
    expect(await access.canManageCourse(actor!, 'course-2')).toBe(false);

    const publishedTask = await pool.query<{ id: string }>(
      `SELECT id FROM app.learning_tasks
       WHERE status = 'published' AND id IN (
         SELECT task_id FROM app.task_assignments WHERE user_id = 'user-1'
       )
       ORDER BY created_at LIMIT 1`,
    );
    expect(await access.canEnterTask(actor!, publishedTask.rows[0].id)).toBe(true);
  });

  it('uses the formal tables for Better Auth login and personnel profiles', async () => {
    const testAuth = betterAuth({
      baseURL: 'http://127.0.0.1:3000',
      secret: 'local-p2-test-secret',
      database: pool,
      emailAndPassword: { enabled: true },
      plugins: [admin()],
    });
    const created = await testAuth.api.createUser({
      body: {
        email: 'teacher@laixue.online',
        password: 'Teacher-P2-2026',
        name: '测试教师',
        role: 'user',
      },
    });
    const people = new PeopleRepository(pool);
    await people.createProfile({
      userId: created.user.id,
      role: 'teacher',
      displayName: '测试教师',
      employeeNo: 'T-001',
    });

    const login = await testAuth.handler(
      new Request('http://127.0.0.1:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'teacher@laixue.online',
          password: 'Teacher-P2-2026',
        }),
      }),
    );
    expect(login.ok).toBe(true);
    expect((await people.listPeople()).some((person) => person.userId === created.user.id)).toBe(
      true,
    );
  });
});
