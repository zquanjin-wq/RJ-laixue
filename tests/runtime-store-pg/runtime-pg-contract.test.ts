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
  test('splits into statements covering both tables and all 13 rpc functions', () => {
    const sql = readFileSync(resolve(__dirname, '../../supabase-runtime-store-v1.sql'), 'utf-8');
    const stmts = splitMigrationStatements(sql);
    const joined = stmts.join('\n');
    for (const needle of [
      'create table if not exists runtime_sessions',
      'create table if not exists runtime_records',
      'runtime_create_session',
      'runtime_get_session',
      'runtime_list_sessions',
      'runtime_update_session',
      'runtime_append_record',
      'runtime_list_records',
      'runtime_list_records_by_scene',
      'runtime_get_record',
      'runtime_delete_session',
      'runtime_merge_learner',
      'runtime_delete_learner_runtime',
      'runtime_delete_stage_runtime',
      'runtime_claim_merge_grant',
      'create table if not exists runtime_merge_grants',
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

  test('merge grant: atomic one-shot claim (ok → invalid on replay, wrong to/from → invalid)', async () => {
    const { pool } = harness.makeStoreWithDb();
    await pool.query(
      `insert into runtime_merge_grants (id, from_learner_key, to_learner_key, expires_at)
       values ($1, $2, $3, $4)`,
      ['grant-1', 'anon:temp', 'user:42', '2099-01-01T00:00:00Z'],
    );
    const claim = async (grantId: string, from: string, to: string) =>
      (
        await pool.query(
          `select runtime_claim_merge_grant($1, $2, $3, $4) as v`,
          [grantId, from, to, '2026-07-29T00:00:00Z'],
        )
      ).rows[0]?.v;

    expect(await claim('grant-1', 'anon:temp', 'user:42')).toBe('ok');
    // 一次性：重放核销失败
    expect(await claim('grant-1', 'anon:temp', 'user:42')).toBe('invalid');

    await pool.query(
      `insert into runtime_merge_grants (id, from_learner_key, to_learner_key, expires_at)
       values ($1, $2, $3, $4)`,
      ['grant-2', 'anon:temp', 'user:42', '2099-01-01T00:00:00Z'],
    );
    // 目标用户不匹配（防止把他人分区并给自己）
    expect(await claim('grant-2', 'anon:temp', 'user:99')).toBe('invalid');
    // 过期 grant
    await pool.query(
      `insert into runtime_merge_grants (id, from_learner_key, to_learner_key, expires_at)
       values ($1, $2, $3, $4)`,
      ['grant-3', 'anon:temp', 'user:42', '2020-01-01T00:00:00Z'],
    );
    expect(await claim('grant-3', 'anon:temp', 'user:42')).toBe('invalid');
  });
});
