/**
 * tests/runtime-store-pg/live-pg-concurrency.test.ts
 *
 * R1.1 真实 PostgreSQL 双连接并发套件——pg-mem 是快速单元测试，不能替代
 * 真实并发语义证据（Codex 联合评审修复卡第 4 条）。本套件用 pg 驱动的
 * 两个独立连接，对生产迁移 SQL（supabase-runtime-store-v1.sql）在真实
 * PG 上行级锁 / READ COMMITTED 行为做六场景断言：
 *
 *   1. 并发 setSessionStatus（同 expect_revision）——恰好一个 'ok'，另一个 'conflict'；
 *   2. 并发 append——TS 风格 CAS 重试后 seq 连续且不重复；
 *   3. 同 record id 并发重放——只落一条（幂等键）；
 *   4. 并发 createSession 同 id——恰好一个 'ok'，另一个稳定 'conflict'；
 *   5. merge 与 create 并发——learner 锁串行化，无行丢失、计数正确；
 *   6. 并发 merge_with_grant 同一 grant——恰好一个成功，另一个 'invalid_grant'。
 *
 * 运行方式（env 门控，默认 skip）：
 *   RUNTIME_LIVE_PG_URL=postgres://user:pass@localhost:5432/rj_runtime_scratch \
 *     pnpm vitest run tests/runtime-store-pg/live-pg-concurrency.test.ts
 *
 * 安全约束：
 *   - URL 必须指向 localhost/127.0.0.1（除非显式 RUNTIME_LIVE_PG_ALLOW_REMOTE=1）；
 *   - beforeAll 会 DROP 并重建 runtime_* 表与函数——务必使用专用 scratch 库，
 *     绝不指向生产/预览数据库。
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Pool, type PoolClient } from 'pg';
import { splitMigrationStatements, isRlsStatement } from './pg-mem-harness';

const LIVE_URL = process.env.RUNTIME_LIVE_PG_URL;
const ALLOW_REMOTE = process.env.RUNTIME_LIVE_PG_ALLOW_REMOTE === '1';
const IS_LOCAL = !!LIVE_URL && /(@|\/\/)(localhost|127\.0\.0\.1)(:|\/|$)/.test(LIVE_URL);
const ENABLED = !!LIVE_URL && (IS_LOCAL || ALLOW_REMOTE);

const RUN = describe.runIf(ENABLED);

if (LIVE_URL && !ENABLED) {
  // 显式给了 URL 但不是本机——拒绝执行（防误指生产），除非 ALLOW_REMOTE=1
  throw new Error(
    'live-pg-concurrency: RUNTIME_LIVE_PG_URL 非 localhost；如确为专用 scratch 库，' +
      '请显式设置 RUNTIME_LIVE_PG_ALLOW_REMOTE=1',
  );
}

const V = '0.1.0'; // RUNTIME_DSL_VERSION（避免引入 alias，测试内保持自包含）
const NOW = '2026-07-29T00:00:00.000Z';

let pool: Pool;

async function scalar(client: PoolClient, fn: string, args: unknown[]): Promise<unknown> {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
  const r = await client.query(`select ${fn}(${placeholders}) as v`, args);
  return r.rows[0]?.v;
}

/** 两个并发调用方各自持有独立连接（真实双连接，不是单连接交错）。 */
async function inParallel<T>(a: () => Promise<T>, b: () => Promise<T>): Promise<[T, T]> {
  return Promise.all([a(), b()]) as Promise<[T, T]>;
}

/**
 * 强制竞争屏障（Codex R1.1 评审第 2 条）：第三个连接在显式事务里预先
 * 持有同一 learner 的咨询锁，待测 RPC 启动并真实阻塞在锁上后再释放——
 * 把「语句快照先建立、随后等待锁」的棘手窗口从概率事件变成必然事件。
 */
async function withAdvisoryBarrier<T>(learnerKey: string, fn: () => Promise<T>): Promise<T> {
  const gate = await pool.connect();
  try {
    await gate.query('begin');
    await gate.query(`select pg_advisory_xact_lock(hashtext($1))`, [learnerKey]);
    const pending = fn();
    // 给阻塞方足够时间真正进入锁等待队列
    await new Promise((r) => setTimeout(r, 400));
    await gate.query('commit');
    return await pending;
  } finally {
    gate.release();
  }
}

beforeAll(async () => {
  if (!ENABLED) return;
  pool = new Pool({ connectionString: LIVE_URL, max: 4 });
  // 重建 scratch schema：drop 级联清掉旧函数（签名变更时 create-or-replace 不够）
  await pool.query(`
    drop table if exists runtime_merge_grants cascade;
    drop table if exists runtime_records cascade;
    drop table if exists runtime_sessions cascade;
    drop table if exists runtime_learner_locks cascade;
  `);
  const sql = readFileSync(resolve(__dirname, '../../supabase-runtime-store-v1.sql'), 'utf-8');
  const statements = splitMigrationStatements(sql).filter((s) => !isRlsStatement(s));
  for (const stmt of statements) {
    await pool.query(stmt);
  }
  // RLS 在迁移里被跳过——scratch 库无 auth.uid()；并发语义不依赖 RLS
}, 60_000);

afterAll(async () => {
  if (pool) await pool.end();
});

async function createSession(
  client: PoolClient,
  id: string,
  learner: string,
  status = 'active',
): Promise<unknown> {
  return scalar(client, 'runtime_create_session', [
    id, V, 'chat', 'stage-live', learner, status, NOW, NOW,
  ]);
}

RUN('live PG concurrency (real postgres, two connections)', () => {
  test('1. 并发 update 同 expect_revision：恰好一个 ok', async () => {
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      expect(await createSession(c1, 'lv-s1', 'anon:a')).toBe('ok');
      const update = (c: PoolClient) =>
        scalar(c, 'runtime_update_session', [
          'lv-s1', V, 'chat', 'stage-live', 'anon:a', 'completed', NOW, NOW, 0,
        ]);
      const [r1, r2] = await inParallel(() => update(c1), () => update(c2));
      expect([r1, r2].sort()).toEqual(['conflict', 'ok']);
      const rev = await c1.query(`select revision from runtime_sessions where id = 'lv-s1'`);
      expect(Number(rev.rows[0].revision)).toBe(1);
    } finally {
      c1.release();
      c2.release();
    }
  });

  test('2. 并发 append（CAS 重试）：seq 连续且不重复', async () => {
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      expect(await createSession(c1, 'lv-s2', 'anon:a')).toBe('ok');
      // TS 风格的读 revision → append → conflict 重试循环
      const appendWithRetry = async (c: PoolClient, recId: string) => {
        for (let i = 0; i < 10; i++) {
          const cur = await c.query(`select revision from runtime_sessions where id = 'lv-s2'`);
          const rev = Number(cur.rows[0].revision);
          const outcome = await scalar(c, 'runtime_append_record', [
            'lv-s2', recId, '', -1, '', NOW, '{"role":"user","content":"x"}', rev,
          ]);
          if (outcome !== 'conflict') return outcome;
        }
        throw new Error('append retry exhausted');
      };
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          appendWithRetry(i % 2 === 0 ? c1 : c2, `lv-r2-${i}`),
        ),
      );
      expect(results.every((r) => r === 'ok')).toBe(true);
      const rows = await c1.query(
        `select seq from runtime_records where session_id = 'lv-s2' order by seq`,
      );
      expect(rows.rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    } finally {
      c1.release();
      c2.release();
    }
  });

  test('3. 同 record id 并发重放：只落一条', async () => {
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      expect(await createSession(c1, 'lv-s3', 'anon:a')).toBe('ok');
      const replay = async (c: PoolClient) => {
        for (let i = 0; i < 10; i++) {
          const cur = await c.query(`select revision from runtime_sessions where id = 'lv-s3'`);
          const outcome = await scalar(c, 'runtime_append_record', [
            'lv-s3', 'lv-r3-dup', '', -1, '', NOW, '{"role":"user","content":"same"}',
            Number(cur.rows[0].revision),
          ]);
          if (outcome !== 'conflict') return outcome;
        }
        throw new Error('replay retry exhausted');
      };
      const [r1, r2] = await inParallel(() => replay(c1), () => replay(c2));
      // 一个真插入，另一个幂等命中；顺序不定
      expect([r1, r2].sort()).toEqual(['id_conflict', 'ok']);
      const rows = await c1.query(
        `select count(*)::int as n from runtime_records where id = 'lv-r3-dup'`,
      );
      expect(rows.rows[0].n).toBe(1);
    } finally {
      c1.release();
      c2.release();
    }
  });

  test('4. 并发 createSession 同 id：恰好一个 ok', async () => {
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      const [r1, r2] = await inParallel(
        () => createSession(c1, 'lv-s4', 'anon:a'),
        () => createSession(c2, 'lv-s4', 'anon:a'),
      );
      expect([r1, r2].sort()).toEqual(['conflict', 'ok']);
    } finally {
      c1.release();
      c2.release();
    }
  });

  test('5. merge 与 create 并发（屏障强制竞争）：报告数与实际移动数精确一致', async () => {
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      expect(await createSession(c1, 'lv-s5-a', 'anon:from')).toBe('ok');
      expect(await createSession(c1, 'lv-s5-b', 'anon:from')).toBe('ok');
      // 屏障：merge 与 create 都真实阻塞在同一 learner 咨询锁上后放行
      const [mergeOutcome, createOutcome] = await withAdvisoryBarrier('anon:from', () =>
        Promise.all([
          scalar(c1, 'runtime_merge_learner', ['anon:from', 'user:to', V]),
          createSession(c2, 'lv-s5-c', 'anon:from'),
        ]),
      );
      expect(createOutcome).toBe('ok');
      expect(String(mergeOutcome)).toMatch(/^ok:\d+$/);
      const rows = await c1.query(
        `select learner_key, count(*)::int as n from runtime_sessions
         where id like 'lv-s5-%' group by learner_key`,
      );
      const byLearner = Object.fromEntries(rows.rows.map((r) => [r.learner_key, r.n]));
      // 无行丢失：3 个会话必然都在（锁串行化：create 在 merge 前落库则被搬走，
      // 在其后落库则留在 anon:from——两种交错都合法）
      const total = (byLearner['user:to'] ?? 0) + (byLearner['anon:from'] ?? 0);
      expect(total).toBe(3);
      // 精确一致（Codex 评审强化点）：merge 报告的移动数 == 实际归属 user:to 的行数
      const reported = Number(String(mergeOutcome).slice('ok:'.length));
      expect(byLearner['user:to']).toBe(reported);
      expect(reported === 2 || reported === 3).toBe(true);
    } finally {
      c1.release();
      c2.release();
    }
  });

  test('6. 并发 merge_with_grant 同一 grant（屏障强制竞争）：稳定一个 ok:1 一个 invalid_grant', async () => {
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      expect(await createSession(c1, 'lv-s6', 'anon:g')).toBe('ok');
      await c1.query(
        `insert into runtime_merge_grants (id, from_learner_key, to_learner_key, expires_at)
         values ('lv-grant-6', 'anon:g', 'user:to', '2099-01-01T00:00:00Z')`,
      );
      const merge = (c: PoolClient) =>
        scalar(c, 'runtime_merge_with_grant', ['lv-grant-6', 'anon:g', 'user:to', V, NOW]);
      // 屏障：双方都进入「快照已建立、等待咨询锁」状态后放行——后放行方的
      // claim 依赖 UPDATE 里的直接条件（used_at is null）在 EvalPlanQual 下
      // 对最新行版本重检，挡住双重核销（Codex 评审第 1 条的实证场景）
      const [r1, r2] = await withAdvisoryBarrier('anon:g', () =>
        Promise.all([merge(c1), merge(c2)]),
      );
      const outcomes = [String(r1), String(r2)].sort();
      expect(outcomes[0]).toBe('invalid_grant');
      expect(outcomes[1]).toBe('ok:1');
      const grant = await c1.query(
        `select used_at from runtime_merge_grants where id = 'lv-grant-6'`,
      );
      expect(grant.rows[0].used_at).not.toBeNull();
      const owner = await c1.query(
        `select count(*)::int as n from runtime_sessions where id = 'lv-s6' and learner_key = 'user:to'`,
      );
      expect(owner.rows[0].n).toBe(1);
    } finally {
      c1.release();
      c2.release();
    }
  });
});
