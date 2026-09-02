/**
 * tests/runtime-store-pg/runtime-pg-contract.test.ts
 *
 * R1 验收：上游 RuntimeStore 契约套件原样跑在 Postgres 后端（pg-mem 加载
 * 生产迁移 SQL）之上。套件全绿 = RuntimeStorePg 与 BrowserRuntimeStore
 * 语义等价，服务端实现可进入 R2 影子双写。
 *
 * 后端自有行为（幂等重放、IDEMPOTENCY_CONFLICT、乐观 CAS 重试）在本文件
 * 的补充 describe 里断言——与上游「契约归契约、后端自有行为归后端文件」
 * 的分工一致（runtime-contract.ts 头注）。
 */
import { afterAll, describe, expect, test } from 'vitest';
import { runRuntimeStoreContract } from '../../packages/@openmaic/storage/test/runtime-contract';
import { createPgMemHarness, splitMigrationStatements } from './pg-mem-harness';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { RuntimeStorePg } from '@/lib/server/runtime-store/pg';
import { RUNTIME_DSL_VERSION } from '@openmaic/dsl';

const harness = createPgMemHarness();

afterAll(async () => {
  await harness.closeAll();
});

runRuntimeStoreContract('postgres (pg-mem)', harness.makeStore);

describe('migration file sanity', () => {
  test('splits into statements covering all tables and all 14 rpc functions', () => {
    const sql = readFileSync(resolve(__dirname, '../../supabase-runtime-store-v1.sql'), 'utf-8');
    const stmts = splitMigrationStatements(sql);
    const joined = stmts.join('\n');
    for (const needle of [
      'create table if not exists runtime_sessions',
      'create table if not exists runtime_records',
      'create table if not exists runtime_merge_grants',
      // learner 级协调：咨询锁（锁表方案已废弃，见迁移头注 ②）
      'pg_advisory_xact_lock(hashtext(p_learner_key))',
      'pg_advisory_xact_lock(hashtext(p_from))',
      'runtime_create_session',
      'runtime_get_session',
      'runtime_list_sessions',
      'runtime_list_sessions_by_learner',
      'runtime_update_session',
      'runtime_append_record',
      'runtime_list_records',
      'runtime_list_records_by_scene',
      'runtime_get_record',
      'runtime_delete_session',
      'runtime_merge_learner',
      'runtime_merge_with_grant',
      'runtime_delete_learner_runtime',
      'runtime_delete_stage_runtime',
      // EXECUTE 收口：浏览器/普通角色不可执行任何 runtime_* 函数
      'revoke execute on function runtime_merge_with_grant(text,text,text,text,text)',
      'grant execute on function runtime_merge_with_grant(text,text,text,text,text) to service_role',
    ]) {
      expect(joined).toContain(needle);
    }
  });
});

describe('RuntimeStorePg backend-specific behaviour', () => {
  test('idempotent replay: same id + same content returns the existing record (no new seq)', async () => {
    const store = harness.makeStore();
    await store.createSession({
      id: 'sess-1',
      kind: 'chat',
      stageId: 'stage-1',
      learnerKey: 'anon:1',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const init = {
      id: 'rec-1',
      sessionId: 'sess-1',
      createdAt: '2026-01-01T00:01:00.000Z',
      payload: { role: 'user', content: 'hi' },
    };
    const first = await store.appendRecord(init);
    const replayed = await store.appendRecord(init);
    expect(replayed).toEqual(first);
    expect((await store.listRecords('sess-1')).length).toBe(1);
    // 重放不消耗 seq：下一条新 record 仍拿到 seq 1
    const next = await store.appendRecord({
      id: 'rec-2',
      sessionId: 'sess-1',
      createdAt: '2026-01-01T00:02:00.000Z',
      payload: { role: 'assistant', content: 'yo' },
    });
    expect(next.seq).toBe(1);
  });

  test('id reuse with different content fails loud (IDEMPOTENCY_CONFLICT)', async () => {
    const store = harness.makeStore();
    await store.createSession({
      id: 'sess-1',
      kind: 'chat',
      stageId: 'stage-1',
      learnerKey: 'anon:1',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await store.appendRecord({
      id: 'rec-1',
      sessionId: 'sess-1',
      createdAt: '2026-01-01T00:01:00.000Z',
      payload: { role: 'user', content: 'hi' },
    });
    await expect(
      store.appendRecord({
        id: 'rec-1',
        sessionId: 'sess-1',
        createdAt: '2026-01-01T00:03:00.000Z',
        payload: { role: 'user', content: 'DIFFERENT' },
      }),
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  test('session stamping comes from the TS layer (RUNTIME_DSL_VERSION), not hard-coded SQL', async () => {
    const store = harness.makeStore();
    const created = await store.createSession({
      id: 'sess-1',
      kind: 'chat',
      stageId: 'stage-1',
      learnerKey: 'anon:1',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(created.runtimeDslVersion).toBe(RUNTIME_DSL_VERSION);
  });

  test('RuntimeStorePg is a class taking an rpc client (contract surface sanity)', () => {
    expect(typeof RuntimeStorePg).toBe('function');
  });

  test('revision CAS: stale p_expect_revision → conflict; 正确 revision → ok 且 revision 递增', async () => {
    const { store, pool } = harness.makeStoreWithDb();
    await store.createSession({
      id: 'sess-1',
      kind: 'chat',
      stageId: 'stage-1',
      learnerKey: 'anon:1',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const revision = async () =>
      Number((await pool.query(`select revision from runtime_sessions where id = 'sess-1'`)).rows[0]?.revision);
    expect(await revision()).toBe(0);

    const update = (expectRevision: number) =>
      pool.query(`select runtime_update_session($1,$2,$3,$4,$5,$6,$7,$8,$9) as v`, [
        'sess-1', RUNTIME_DSL_VERSION, 'chat', 'stage-1', 'anon:1', 'completed',
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', expectRevision,
      ]).then((r) => r.rows[0]?.v);

    // 陈旧 revision（模拟并发方已写入）→ CAS 失败
    expect(await update(99)).toBe('conflict');
    expect(await revision()).toBe(0);
    // 正确 revision → 写入成功且递增；此后旧 revision 永远失效
    expect(await update(0)).toBe('ok');
    expect(await revision()).toBe(1);
    expect(await update(0)).toBe('conflict');
  });

  test('merge_with_grant: 无效/过期/目标不匹配 → invalid_grant 且不搬移、不烧 grant', async () => {
    const { store, pool } = harness.makeStoreWithDb();
    await store.createSession({
      id: 'sess-1', kind: 'chat', stageId: 'stage-1', learnerKey: 'anon:temp',
      status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const grant = async (id: string, expires: string) =>
      pool.query(
        `insert into runtime_merge_grants (id, from_learner_key, to_learner_key, expires_at)
         values ($1, $2, $3, $4)`,
        [id, 'anon:temp', 'user:42', expires],
      );
    const merge = (grantId: string, from = 'anon:temp', to = 'user:42') =>
      pool.query(`select runtime_merge_with_grant($1,$2,$3,$4,$5) as v`, [
        grantId, from, to, RUNTIME_DSL_VERSION, '2026-07-29T00:00:00Z',
      ]).then((r) => String(r.rows[0]?.v));
    const usedAt = async (grantId: string) =>
      (await pool.query(`select used_at from runtime_merge_grants where id = $1`, [grantId])).rows[0]?.used_at;
    const ownerOf = async (id: string) =>
      (await pool.query(`select learner_key from runtime_sessions where id = $1`, [id])).rows[0]?.learner_key;

    await grant('grant-expired', '2020-01-01T00:00:00Z');
    expect(await merge('grant-expired')).toBe('invalid_grant');
    expect(await usedAt('grant-expired')).toBeNull();
    expect(await ownerOf('sess-1')).toBe('anon:temp');

    await grant('grant-2', '2099-01-01T00:00:00Z');
    // 目标用户不匹配（防止把他人分区并给自己）
    expect(await merge('grant-2', 'anon:temp', 'user:99')).toBe('invalid_grant');
    expect(await usedAt('grant-2')).toBeNull();
    expect(await ownerOf('sess-1')).toBe('anon:temp');

    // 成功：搬移 + 核销原子完成；重放 → invalid_grant（一次性语义）
    expect(await merge('grant-2')).toBe('ok:1');
    expect(await ownerOf('sess-1')).toBe('user:42');
    expect(await usedAt('grant-2')).not.toBeNull();
    expect(await merge('grant-2')).toBe('invalid_grant');
  });

  test('merge_with_grant: version_conflict 不烧 grant，迁移后同一 grant 可重试成功', async () => {
    const { pool } = harness.makeStoreWithDb();
    // 直接插入一行旧版本会话（模拟等待迁移的数据）
    await pool.query(
      `insert into runtime_sessions (id, runtime_dsl_version, kind, stage_id, learner_key, status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ['sess-old', '0.0.0', 'chat', 'stage-1', 'anon:temp', 'active',
       '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
    );
    await pool.query(
      `insert into runtime_merge_grants (id, from_learner_key, to_learner_key, expires_at)
       values ($1, $2, $3, $4)`,
      ['grant-v', 'anon:temp', 'user:42', '2099-01-01T00:00:00Z'],
    );
    const merge = () =>
      pool.query(`select runtime_merge_with_grant($1,$2,$3,$4,$5) as v`, [
        'grant-v', 'anon:temp', 'user:42', RUNTIME_DSL_VERSION, '2026-07-29T00:00:00Z',
      ]).then((r) => String(r.rows[0]?.v));
    const usedAt = async () =>
      (await pool.query(`select used_at from runtime_merge_grants where id = 'grant-v'`)).rows[0]?.used_at;

    expect(await merge()).toBe('version_conflict');
    // 关键断言：版本冲突不烧 grant、不搬移
    expect(await usedAt()).toBeNull();
    expect(
      (await pool.query(`select learner_key from runtime_sessions where id = 'sess-old'`)).rows[0]?.learner_key,
    ).toBe('anon:temp');

    // 模拟 TS 层迁移（路由在 version_conflict 后做 migrateLearnerRuntime 再重试）
    await pool.query(
      `update runtime_sessions set runtime_dsl_version = $1 where id = 'sess-old'`,
      [RUNTIME_DSL_VERSION],
    );
    expect(await merge()).toBe('ok:1');
    expect(await usedAt()).not.toBeNull();
    expect(
      (await pool.query(`select learner_key from runtime_sessions where id = 'sess-old'`)).rows[0]?.learner_key,
    ).toBe('user:42');
  });
});
