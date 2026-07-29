/**
 * tests/runtime-store-pg/pg-mem-harness.ts
 *
 * pg-mem 契约测试 harness：把仓库根目录的 supabase-runtime-store-v1.sql
 * （生产迁移，真 PG / Supabase 执行的同一份 SQL）加载进 pg-mem 内存库，
 * 再用 pg-mem 的 node-pg 适配器实现 RuntimeStoreRpcClient。
 *
 * 已知且接受的 pg-mem 偏差（探针 1–13 实测，见 R1 报告）：
 *   1. RLS / policy 语句不支持——harness 跳过（生产授权在 API 层，RLS 仅为
 *      防御纵深，契约行为不依赖它）；
 *   2. 多语句脚本不支持——按语句拆分逐条执行；
 *   3. 绑定 null 参数不可靠——SQL 函数集设计为哨兵值传参（'' / -1），
 *      本 harness 与生产 PostgREST 走同一形状；
 *   4. ON CONFLICT DO NOTHING 的 returning 在冲突时仍非空——append 函数用
 *      not-exists 前置守卫规避，TS 层取回行比对做终判。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { newDb } from 'pg-mem';
import { RuntimeStorePg, type RuntimeStoreRpcClient } from '@/lib/server/runtime-store/pg';
import type { RuntimeStore } from '@openmaic/storage';

/** 函数名 → 声明参数顺序（与 supabase-runtime-store-v1.sql 签名一致）。 */
const PARAM_ORDER: Record<string, string[]> = {
  runtime_create_session: [
    'p_id', 'p_version', 'p_kind', 'p_stage_id', 'p_learner_key',
    'p_status', 'p_created_at', 'p_updated_at',
  ],
  runtime_get_session: ['p_id'],
  runtime_list_sessions: ['p_stage_id', 'p_learner_key'],
  runtime_list_sessions_by_learner: ['p_learner_key'],
  runtime_update_session: [
    'p_id', 'p_version', 'p_kind', 'p_stage_id', 'p_learner_key',
    'p_status', 'p_created_at', 'p_updated_at', 'p_expect_version',
  ],
  runtime_append_record: [
    'p_session_id', 'p_id', 'p_scene_id', 'p_action_index',
    'p_sub_anchor', 'p_created_at', 'p_payload', 'p_expect_version',
  ],
  runtime_list_records: ['p_session_id'],
  runtime_list_records_by_scene: ['p_session_id', 'p_scene_id'],
  runtime_get_record: ['p_id'],
  runtime_delete_session: ['p_id'],
  runtime_merge_learner: ['p_from', 'p_to', 'p_expect_version'],
  runtime_delete_learner_runtime: ['p_stage_id', 'p_learner_key'],
  runtime_delete_stage_runtime: ['p_stage_id'],
  runtime_claim_merge_grant: ['p_grant_id', 'p_from', 'p_to', 'p_now'],
};

interface PgLikePool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

/** 把迁移 SQL 拆成单条语句（函数体含 $$ 块，不能简单按分号切）。 */
export function splitMigrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let buf = '';
  let inFn = false;
  for (const line of sql.split('\n')) {
    buf += line + '\n';
    if (!inFn && line.includes('as $$')) {
      inFn = true;
      continue;
    }
    if (inFn) {
      if (line.trim().endsWith('$$;')) {
        statements.push(buf.trim().replace(/;$/, ''));
        buf = '';
        inFn = false;
      }
      continue;
    }
    if (line.trim().endsWith(';')) {
      statements.push(buf.trim().replace(/;$/, ''));
      buf = '';
    }
  }
  const rest = buf.trim();
  if (rest) statements.push(rest.replace(/;$/, ''));
  return statements.filter((s) => s.length > 0);
}

/** pg-mem 不支持的语句：RLS 相关（授权在 API 层，契约测试不涉及）。 */
function isRlsStatement(stmt: string): boolean {
  // 语句可能带前导注释行，去掉注释后取首个有效行判断
  const code = stmt
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .trim()
    .toLowerCase();
  return (
    code.startsWith('alter table') ||
    code.startsWith('create policy') ||
    code.startsWith('drop policy')
  );
}

function orderedArgs(fn: string, args: Record<string, unknown>): unknown[] {
  const order = PARAM_ORDER[fn];
  if (!order) throw new Error(`pg-mem harness: unknown rpc function '${fn}'`);
  return order.map((name) => {
    if (!(name in args)) throw new Error(`pg-mem harness: missing arg '${name}' for ${fn}`);
    return args[name];
  });
}

export interface PgMemHarness {
  makeStore(): RuntimeStore;
  /** 需要直接 SQL 断言的后端自有行为测试（如 merge grant 核销）。 */
  makeStoreWithDb(): { store: RuntimeStore; pool: PgLikePool };
  closeAll(): Promise<void>;
}

/** 每个 makeStore() 一个全新内存库（与 browser 契约测试的 fresh-IDB 语义一致）。 */
export function createPgMemHarness(): PgMemHarness {
  const pools: PgLikePool[] = [];
  const migrationSql = readFileSync(
    resolve(__dirname, '../../supabase-runtime-store-v1.sql'),
    'utf-8',
  );
  const statements = splitMigrationStatements(migrationSql).filter((s) => !isRlsStatement(s));

  const makeStoreWithDb = (): { store: RuntimeStore; pool: PgLikePool } => {
    const db = newDb();
    for (const stmt of statements) {
      db.public.query(stmt);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PgPool = db.adapters.createPg().Pool as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = new PgPool() as any as PgLikePool;
    pools.push(pool);

    const rpc: RuntimeStoreRpcClient = {
      async scalar(fn, args) {
        const values = orderedArgs(fn, args);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
        const result = await pool.query(`select ${fn}(${placeholders}) as v`, values);
        return result.rows[0]?.v;
      },
      async rows<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
        const values = orderedArgs(fn, args);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
        const result = await pool.query(`select * from ${fn}(${placeholders})`, values);
        return result.rows as T[];
      },
    };
    return { store: new RuntimeStorePg(rpc), pool };
  };

  return {
    makeStore: () => makeStoreWithDb().store,
    makeStoreWithDb,
    async closeAll() {
      await Promise.all(pools.map((p) => p.end()));
    },
  };
}
