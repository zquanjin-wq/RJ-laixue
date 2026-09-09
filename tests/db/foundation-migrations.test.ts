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
import { CourseVideoExportRepository } from '@/lib/server/db/course-video-export-repository';
import { AccessRepository } from '@/lib/server/db/access-repository';
import { JobRepository } from '@/lib/server/db/job-repository';
import { PptxSourceRepository } from '@/lib/server/db/pptx-source-repository';
import {
  ClassroomGenerationRepository,
  GenerationIdempotencyConflict,
  GenerationLeaseLost,
  generationRequestHash,
} from '@/lib/server/db/classroom-generation-repository';
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
      '0008_learning_analytics_and_revoice.sql',
      '0009_course_video_exports.sql',
      '0010_classroom_generation_jobs.sql',
      '0011_classroom_generation_sources.sql',
      '0012_pptx_ai_classroom_pipeline.sql',
      '0013_classroom_generation_events.sql',
      '0014_api_tokens.sql',
      '0015_revoice_source_revision.sql',
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

  it('deduplicates generation requests and fences reclaimed or cancelled workers', async () => {
    const jobs = new ClassroomGenerationRepository(pool);
    const request = {
      ownerUserId: 'user-1',
      operation: 'create' as const,
      channel: 'web' as const,
      inputKind: 'text' as const,
      idempotencyKey: 'generation-concurrent',
      payload: { requirement: '欢迎新同事', enableTTS: false },
    };
    const submitted = await Promise.all([jobs.enqueue(request), jobs.enqueue(request)]);
    expect(submitted[0].id).toBe(submitted[1].id);
    expect(submitted[0].courseId).toBe(submitted[1].courseId);
    expect(submitted.filter((job) => !job.reused)).toHaveLength(1);
    expect(generationRequestHash({ a: 1, b: 2 })).toBe(generationRequestHash({ b: 2, a: 1 }));
    await expect(
      jobs.enqueue({ ...request, payload: { requirement: 'different' } }),
    ).rejects.toBeInstanceOf(GenerationIdempotencyConflict);
    const count = await pool.query(
      `SELECT count(*)::int AS n FROM app.background_jobs WHERE type='classroom-generation'`,
    );
    expect(count.rows[0].n).toBe(1);

    const claimed = await Promise.all([jobs.claimNext('worker-a'), jobs.claimNext('worker-b')]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    const first = claimed.find(Boolean)!;
    const fingerprint = generationRequestHash(request.payload);
    await jobs.saveStep(first, 'outlines', fingerprint, { pages: ['stable-page-id'] });
    await jobs.heartbeat(first, { step: 'outlines', progress: 20 });
    await pool.query(
      `UPDATE app.background_jobs SET locked_until=now()-interval '1 second' WHERE id=$1`,
      [first.id],
    );
    await expect(jobs.heartbeat(first, {})).rejects.toBeInstanceOf(GenerationLeaseLost);
    const recovered = (await jobs.claimNext('worker-c'))!;
    expect(recovered.epoch).toBe(first.epoch + 1);
    expect(recovered.courseId).toBe(first.courseId);
    expect(await jobs.readStep(recovered, 'outlines', fingerprint)).toEqual({
      pages: ['stable-page-id'],
    });
    expect(await jobs.readStep(recovered, 'outlines', 'different')).toBeNull();
    await expect(jobs.saveStep(first, 'outlines', fingerprint, {})).rejects.toBeInstanceOf(
      GenerationLeaseLost,
    );
    await expect(jobs.fail(first, 'OLD', 'stale', false)).rejects.toBeInstanceOf(
      GenerationLeaseLost,
    );
    await new JobRepository(pool).succeed(first.id, { bypass: true });
    expect(await jobs.cancel(first.id, 'wrong-owner')).toBe(false);
    expect(await jobs.cancel(first.id, 'user-1')).toBe(true);
    await expect(jobs.saveStep(recovered, 'scenes', fingerprint, {})).rejects.toBeInstanceOf(
      GenerationLeaseLost,
    );
    await expect(jobs.heartbeat(recovered, {})).rejects.toBeInstanceOf(GenerationLeaseLost);
    await expect(jobs.fail(recovered, 'LATE', 'cancelled', true)).rejects.toBeInstanceOf(
      GenerationLeaseLost,
    );
    expect(await jobs.claimNext('worker-d')).toBeNull();
  });

  it('registers only a confirmed, owned PPTX material as a reusable source', async () => {
    const courses = new CourseRepository(pool);
    const sources = new PptxSourceRepository(pool);
    const asset = await courses.createAsset({
      ownerUserId: 'user-1',
      kind: 'material',
      objectKey: 'pending/user-1/material/source.pptx',
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      sizeBytes: 1024,
    });
    await expect(
      sources.register({
        ownerUserId: 'user-1',
        assetId: asset.id,
        originalFilename: '源课件.pptx',
      }),
    ).rejects.toThrow('not confirmed');
    await courses.markAssetReady(asset.objectKey, 'user-1');
    const first = await sources.register({
      ownerUserId: 'user-1',
      assetId: asset.id,
      originalFilename: '源课件.pptx',
    });
    const repeated = await sources.register({
      ownerUserId: 'user-1',
      assetId: asset.id,
      originalFilename: '源课件.pptx',
    });
    expect(repeated.id).toBe(first.id);
    expect((await sources.getOwned(first.id, 'user-1'))?.status).toBe('uploaded');
    await expect(
      sources.register({
        ownerUserId: 'other-user',
        assetId: asset.id,
        originalFilename: '源课件.pptx',
      }),
    ).rejects.toThrow('not owned');
  });

  it('backs off transient generation failures and terminates exhausted leases', async () => {
    const jobs = new ClassroomGenerationRepository(pool);
    const submitted = await jobs.enqueue({
      ownerUserId: 'user-1',
      operation: 'create',
      channel: 'skill',
      inputKind: 'text',
      idempotencyKey: 'generation-retry',
      payload: { requirement: 'retry' },
    });
    let lease = (await jobs.claimNext('retry-worker'))!;
    await jobs.fail(lease, 'TEMPORARY', 'provider unavailable', true);
    expect(await jobs.claimNext('early-worker')).toBeNull();
    await pool.query(
      `UPDATE app.background_jobs SET run_after=now()-interval '1 second' WHERE id=$1`,
      [submitted.id],
    );
    lease = (await jobs.claimNext('retry-worker'))!;
    expect(lease.attempts).toBe(2);
    await jobs.fail(lease, 'TEMPORARY', 'provider unavailable', true);
    await pool.query(
      `UPDATE app.background_jobs SET run_after=now()-interval '1 second' WHERE id=$1`,
      [submitted.id],
    );
    lease = (await jobs.claimNext('retry-worker'))!;
    expect(lease.attempts).toBe(3);
    await pool.query(
      `UPDATE app.background_jobs SET locked_until=now()-interval '1 second' WHERE id=$1`,
      [submitted.id],
    );
    expect(await jobs.claimNext('recovery-worker')).toBeNull();
    const result = await pool.query(
      `SELECT status,error_code FROM app.background_jobs WHERE id=$1`,
      [submitted.id],
    );
    expect(result.rows[0]).toEqual({ status: 'failed', error_code: 'ATTEMPTS_EXHAUSTED' });
    await expect(jobs.heartbeat(lease, {})).rejects.toBeInstanceOf(GenerationLeaseLost);
  });

  it('commits the formal draft atomically and refuses revoked roles and stale revisions', async () => {
    const jobs = new ClassroomGenerationRepository(pool);
    const courses = new CourseRepository(pool);
    const created = await jobs.enqueue({
      ownerUserId: 'user-1',
      operation: 'create',
      channel: 'web',
      inputKind: 'text',
      idempotencyKey: 'generation-commit',
      payload: { requirement: 'formal draft' },
    });
    const lease = (await jobs.claimNext('commit-worker'))!;
    const draft = {
      stage: {
        id: created.courseId,
        name: '正式草稿',
        style: 'interactive' as const,
        createdAt: 1,
        updatedAt: 1,
      },
      scenes: [
        {
          id: 'generated-scene',
          stageId: created.courseId,
          type: 'slide' as const,
          title: '欢迎',
          order: 0,
          content: {
            type: 'slide' as const,
            canvas: {
              id: 'canvas',
              elements: [],
              viewportSize: 1280,
              viewportRatio: 0.5625,
              theme: {
                themeColors: ['#3366ff'],
                fontColor: '#000000',
                fontName: 'Arial',
                backgroundColor: '#ffffff',
              },
            },
          },
          actions: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    await expect(jobs.commitCourse(lease, draft)).rejects.toThrow('no longer create courses');
    expect(await courses.getCourse(created.courseId)).toBeNull();
    await pool.query(`UPDATE app.user_profiles SET role='teacher' WHERE user_id='user-1'`);
    const committed = await jobs.commitCourse(lease, draft);
    expect(committed).toEqual({ status: 'succeeded', courseId: created.courseId, revision: 1 });
    expect((await courses.getCourse(created.courseId))?.saveState).toBe('draft');
    await expect(jobs.commitCourse(lease, draft)).rejects.toBeInstanceOf(GenerationLeaseLost);

    await jobs.enqueue({
      ownerUserId: 'user-1',
      operation: 'enhance',
      channel: 'web',
      inputKind: 'pptx',
      courseId: created.courseId,
      sourceRevision: 1,
      idempotencyKey: 'enhance-conflict',
      payload: {},
    });
    const enhancer = (await jobs.claimNext('enhance-worker'))!;
    await courses.updateCourse({
      id: created.courseId,
      ownerUserId: 'user-1',
      expectedRevision: 1,
      title: '讲师的新修改',
      content: { edited: true },
      saveState: 'draft',
    });
    expect(await jobs.commitCourse(enhancer, draft)).toEqual({ status: 'conflict' });
    expect((await courses.getCourse(created.courseId))?.title).toBe('讲师的新修改');
    await pool.query(`UPDATE app.user_profiles SET role='learner' WHERE user_id='user-1'`);
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
    expect(asset.state).toBe('pending');
    expect(await courses.markAssetReady(asset.objectKey, 'user-1')).toMatchObject({
      state: 'ready',
    });

    const firstSnapshot = await courses.createSnapshot('course-1', 'user-1');
    const repeatedSnapshot = await courses.createSnapshot('course-1', 'user-1');
    expect(firstSnapshot?.courseRevision).toBe(2);
    expect(repeatedSnapshot?.id).toBe(firstSnapshot?.id);
    expect(firstSnapshot?.content).toEqual({ scenes: [{ id: 'scene-1', title: '欢迎加入' }] });

    expect(await courses.softDeleteCourse('course-1', 'user-1')).toBe(true);
    expect(await courses.getCourse('course-1')).toBeNull();
  });

  it('stores course video export status and its COS output reference atomically', async () => {
    const courses = new CourseRepository(pool);
    await courses.createCourse({
      id: 'course-video-export',
      ownerUserId: 'user-1',
      title: 'Exportable course',
      content: {},
    });
    const exports = new CourseVideoExportRepository(pool);
    const created = await exports.create({
      courseId: 'course-video-export',
      requestedBy: 'user-1',
      request: { resolution: '1080p' },
    });
    expect(created.status).toBe('queued');
    expect(created.output).toBeNull();

    const running = await exports.updateStatus({
      id: created.id,
      status: 'running',
      expectedStatuses: ['queued'],
    });
    expect(running?.startedAt).toBeInstanceOf(Date);
    expect(
      await exports.recordOutput({
        id: created.id,
        output: {
          bucket: 'laixue-course-exports',
          objectKey: `course-exports/${created.id}.mp4`,
          contentType: 'video/mp4',
          sizeBytes: 2048,
          etag: 'etag-1',
        },
      }),
    ).toMatchObject({
      status: 'succeeded',
      output: {
        bucket: 'laixue-course-exports',
        objectKey: `course-exports/${created.id}.mp4`,
        contentType: 'video/mp4',
        sizeBytes: 2048,
        etag: 'etag-1',
      },
    });
    expect(await exports.updateStatus({ id: created.id, status: 'failed' })).toBeNull();
    expect((await exports.listForCourse('course-video-export'))[0]?.id).toBe(created.id);
  });

  it('only lets the worker claim a video export after its COS source upload is activated', async () => {
    const courses = new CourseRepository(pool);
    await courses.createCourse({
      id: 'course-video-activation',
      ownerUserId: 'user-1',
      title: 'Activation course',
      content: {},
    });
    const exports = new CourseVideoExportRepository(pool);
    const pending = await exports.create({
      courseId: 'course-video-activation',
      requestedBy: 'user-1',
      request: {
        uploadObjectKey: 'courses/course-video-activation/video-exports/pending/source.zip',
      },
    });

    expect(await exports.claimNext()).toBeNull();
    expect(await exports.activateInput(pending.id)).toMatchObject({
      id: pending.id,
      status: 'queued',
    });
    expect(await exports.claimNext()).toMatchObject({ id: pending.id, status: 'running' });

    const uploadFailed = await exports.create({
      courseId: 'course-video-activation',
      requestedBy: 'user-1',
      request: {
        uploadObjectKey: 'courses/course-video-activation/video-exports/failed/source.zip',
      },
    });
    expect(await exports.claimNext()).toBeNull();
    expect((await exports.get(uploadFailed.id))?.status).toBe('queued');
  });

  it('retries a failed video with the durable source, not a stale renderer job id', async () => {
    const exports = new CourseVideoExportRepository(pool);
    const created = await exports.create({
      courseId: 'course-video-activation',
      requestedBy: 'user-1',
      request: {
        inputObjectKey: 'courses/course-video-activation/video-exports/retry/source.zip',
        render: { jobId: 'renderer-job-lost-after-restart', progress: 0.4 },
      },
    });
    await exports.updateStatus({ id: created.id, status: 'running', expectedStatuses: ['queued'] });
    await exports.updateStatus({ id: created.id, status: 'failed', expectedStatuses: ['running'] });

    const retried = await exports.retry(created.id);

    expect(retried).toMatchObject({ id: created.id, status: 'queued' });
    expect(retried?.request).toMatchObject({
      inputObjectKey: 'courses/course-video-activation/video-exports/retry/source.zip',
    });
    expect((retried?.request as { render?: unknown }).render).toBeUndefined();
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
