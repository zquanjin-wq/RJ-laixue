/**
 * lib/server/runtime-store/pg.ts
 *
 * RuntimeStore 的 Postgres 后端（RJ-contract-v1）：实现上游 RuntimeStore 接口，
 * 所有 SQL 集中在 supabase-runtime-store-v1.sql 的 rpc 函数里，本类只做：
 *   - 信封校验 / 版本盖戳 / 读取迁移（与 BrowserRuntimeStore 逐条等价）；
 *   - snake_case 行 ↔ camelCase 契约对象的映射；
 *   - 哨兵值（'' / -1）与可选锚点字段的互转；payload 的 JSON.stringify 桥接；
 *   - 幂等重放（id_conflict）后取回已有行并逐字段比对，防 id 复用串内容。
 *
 * RpcClient 抽象有两个实现：
 *   - 生产：Supabase service client（PostgREST rpc）；
 *   - 测试：pg-mem 加载同一份迁移 SQL（tests/runtime-store-pg/）。
 *
 * 与 browser 语义的有意差异（均为 RJ-contract-v1 强化，不影响契约套件）：
 *   1. record id 全局唯一（幂等键）；同 id 同内容重放返回已有行，
 *      同 id 不同内容抛 IDEMPOTENCY_CONFLICT；
 *   2. setSessionStatus / appendRecord 的「父会话迁移后写回」用整行乐观 CAS
 *      （p_expect_revision——独立递增的并发版本号，DSL 版本不兼任），并发写
 *      冲突时重试一次再 fail-loud；
 *   3. mergeLearner 以函数返回的真实移动数为准（不比较预读行数——预读与
 *      搬移之间的并发变化由 learner 锁消除，见 runtime_learner_locks）。
 */
import {
  RUNTIME_DSL_VERSION,
  migrateRuntime,
  needsRuntimeMigration,
  runtimeDslVersionOf,
  validateRuntimeRecord,
  validateRuntimeSession,
} from '@openmaic/dsl';
import type {
  RuntimePayload,
  RuntimeRecord,
  RuntimeRecordInit,
  RuntimeSession,
  RuntimeSessionStatus,
} from '@openmaic/dsl';
import type {
  RuntimePayloadValidator,
  RuntimeSessionInit,
  RuntimeStore,
} from '@openmaic/storage';
import { RJ_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';

// ── rpc 客户端抽象 ─────────────────────────────────────────────────

/** 具名参数 rpc 调用面：PostgREST 与 pg-mem harness 各自实现。 */
export interface RuntimeStoreRpcClient {
  /** 标量返回函数（outcome 词 / 计数）。 */
  scalar(fn: string, args: Record<string, unknown>): Promise<unknown>;
  /** returns table 函数，返回行数组。 */
  rows<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>): Promise<T[]>;
}

export interface RuntimeStorePgOptions {
  /** per-kind payload 校验，默认 RJ 共享映射（DSL 骨架 kind）。 */
  payloadValidators?: Record<string, RuntimePayloadValidator>;
}

// ── 行形状 ─────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  runtime_dsl_version: string; // semver 'x.y.z'；顺序比较走 @openmaic/dsl，SQL 只做相等 CAS
  // 并发版本号（bigint）：node-pg/pg-mem 可能返回 string，PostgREST 返回 number——
  // 用 Number() 归一化后才可作 p_expect_revision 传回。
  revision: number | string;
  kind: string;
  stage_id: string;
  learner_key: string;
  status: string;
  created_at: unknown; // Date（pg-mem / node-pg）或 ISO string（PostgREST）
  updated_at: unknown;
  next_seq: number;
}

interface RecordRow {
  session_id: string;
  seq: number;
  id: string;
  scene_id: string | null;
  action_index: number | null;
  sub_anchor: string | null;
  created_at: unknown;
  payload: unknown;
}

// ── 映射工具 ───────────────────────────────────────────────────────

/** timestamptz → ISO-8601 UTC（'...Z'）。PostgREST 已给 ISO；Date 则转换。 */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    // PostgREST 的 ISO 直接可用；pg 文本协议形如 '2026-01-01 00:00:00+00' 则转换
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value).toISOString();
    return new Date(value.replace(' ', 'T')).toISOString();
  }
  throw new Error(`@openmaic/storage-pg: unexpected timestamptz value: ${String(value)}`);
}

function sessionFromRow(row: SessionRow): RuntimeSession {
  return {
    id: row.id,
    runtimeDslVersion: row.runtime_dsl_version,
    kind: row.kind,
    stageId: row.stage_id,
    learnerKey: row.learner_key,
    status: row.status as RuntimeSessionStatus,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function recordFromRow<TPayload extends RuntimePayload>(row: RecordRow): RuntimeRecord<TPayload> {
  const record: Record<string, unknown> = {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    createdAt: toIso(row.created_at),
    payload: row.payload,
  };
  // 契约的可选锚点：SQL NULL ↔ 键缺省
  if (row.scene_id !== null) record.sceneId = row.scene_id;
  if (row.action_index !== null) record.actionIndex = row.action_index;
  if (row.sub_anchor !== null) record.subAnchor = row.sub_anchor;
  return record as unknown as RuntimeRecord<TPayload>;
}

function assertValid(result: { valid: boolean; errors?: { path: string; message: string }[] }, label: string): void {
  if (result.valid) return;
  const detail = (result.errors ?? []).map((e) => `${e.path || '/'}: ${e.message}`).join('; ');
  throw new Error(`@openmaic/storage-pg: invalid ${label}: ${detail}`);
}

function isFutureRuntimeVersioned(session: RuntimeSession): boolean {
  // 与 browser 后端同定义：不需要迁移（版本 >= 当前）且不等于当前 = 严格未来版本。
  // 版本戳损坏（缺失/畸形/盖错线）时 runtimeDslVersionOf 抛出版本线自己的错误——
  // 作为存储行损坏向上传播（同 browser 行为）。
  return !needsRuntimeMigration(session) && runtimeDslVersionOf(session) !== RUNTIME_DSL_VERSION;
}

function futureSessionError(sessionId: string, version: string): Error {
  return new Error(
    `@openmaic/storage-pg: session ${JSON.stringify(sessionId)} was written at runtime DSL ` +
      `version ${JSON.stringify(version)}, newer than this client's ${RUNTIME_DSL_VERSION}`,
  );
}

/** 深比较（幂等重放判定）：JSON 键序无关。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

// ── 实现 ───────────────────────────────────────────────────────────

export class RuntimeStorePg implements RuntimeStore {
  private readonly rpc: RuntimeStoreRpcClient;
  private readonly payloadValidators: Record<string, RuntimePayloadValidator>;

  constructor(rpc: RuntimeStoreRpcClient, options: RuntimeStorePgOptions = {}) {
    this.rpc = rpc;
    this.payloadValidators = options.payloadValidators ?? RJ_RUNTIME_PAYLOAD_VALIDATORS;
  }

  private validatorFor(kind: string): RuntimePayloadValidator | undefined {
    return Object.hasOwn(this.payloadValidators, kind) ? this.payloadValidators[kind] : undefined;
  }

  private async readSessionRow(sessionId: string): Promise<SessionRow | undefined> {
    const rows = await this.rpc.rows<SessionRow>('runtime_get_session', { p_id: sessionId });
    return rows[0];
  }

  async createSession(init: RuntimeSessionInit): Promise<RuntimeSession> {
    // 盖戳 + 预校验在 rpc 之前完成：无效信封不产生任何写（同 browser）。
    const stamped: RuntimeSession = { ...init, runtimeDslVersion: RUNTIME_DSL_VERSION };
    assertValid(validateRuntimeSession(stamped), `runtime session ${JSON.stringify(stamped.id)}`);

    const outcome = await this.rpc.scalar('runtime_create_session', {
      p_id: stamped.id,
      p_version: stamped.runtimeDslVersion,
      p_kind: stamped.kind,
      p_stage_id: stamped.stageId,
      p_learner_key: stamped.learnerKey,
      p_status: stamped.status,
      p_created_at: stamped.createdAt,
      p_updated_at: stamped.updatedAt,
    });
    if (outcome !== 'ok') {
      throw new Error(`@openmaic/storage-pg: session ${JSON.stringify(stamped.id)} already exists`);
    }
    return stamped;
  }

  async getSession(sessionId: string): Promise<RuntimeSession | undefined> {
    const row = await this.readSessionRow(sessionId);
    if (!row) return undefined;
    const session = needsRuntimeMigration(sessionFromRow(row))
      ? (migrateRuntime(sessionFromRow(row)) as RuntimeSession)
      : sessionFromRow(row);
    // 直读 fail-loud：版本戳损坏或信封损坏都是存储行完整性失败（同 browser）。
    assertValid(validateRuntimeSession(session), `stored runtime session ${JSON.stringify(sessionId)}`);
    return session;
  }

  async listSessions(stageId: string, learnerKey: string): Promise<RuntimeSession[]> {
    const rows = await this.rpc.rows<SessionRow>('runtime_list_sessions', {
      p_stage_id: stageId,
      p_learner_key: learnerKey,
    });
    // 列举容忍坏行（省略），直读保持 fail-loud（listDocuments 先例）。
    const sessions: RuntimeSession[] = [];
    for (const row of rows) {
      try {
        const base = sessionFromRow(row);
        const session = needsRuntimeMigration(base) ? (migrateRuntime(base) as RuntimeSession) : base;
        assertValid(validateRuntimeSession(session), `stored runtime session ${JSON.stringify(session.id)}`);
        sessions.push(session);
      } catch {
        // omitted
      }
    }
    // SQL 已按 (created_at, id) 排序；再按时刻防御性排一次（代价可忽略）。
    return sessions.sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  async setSessionStatus(
    sessionId: string,
    status: RuntimeSessionStatus,
    updatedAt: string,
  ): Promise<void> {
    await this.readModifyWriteSession(sessionId, (session) => ({ ...session, status, updatedAt }));
  }

  /**
   * 读 → 守护 →（必要时）迁移 → 校验 → 乐观 CAS 写回；CAS 冲突重试一次。
   * browser 在单事务内做同样的事；服务端没有跨语句事务，用 expect_version
   * 保证等价原子性（并发写方冲突时响亮失败而非静默覆盖）。
   */
  private async readModifyWriteSession(
    sessionId: string,
    mutate: (session: RuntimeSession) => RuntimeSession,
  ): Promise<RuntimeSession> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await this.readSessionRow(sessionId);
      if (!row) {
        throw new Error(`@openmaic/storage-pg: no session ${JSON.stringify(sessionId)}`);
      }
      if (isFutureRuntimeVersioned(sessionFromRow(row))) {
        throw futureSessionError(sessionId, row.runtime_dsl_version);
      }
      const stored = sessionFromRow(row);
      const migrated = needsRuntimeMigration(stored) ? (migrateRuntime(stored) as RuntimeSession) : stored;
      const updated = mutate(migrated);
      assertValid(validateRuntimeSession(updated), `runtime session ${JSON.stringify(sessionId)}`);

      const outcome = await this.rpc.scalar('runtime_update_session', {
        p_id: updated.id,
        p_version: updated.runtimeDslVersion,
        p_kind: updated.kind,
        p_stage_id: updated.stageId,
        p_learner_key: updated.learnerKey,
        p_status: updated.status,
        p_created_at: updated.createdAt,
        p_updated_at: updated.updatedAt,
        p_expect_revision: Number(row.revision),
      });
      if (outcome === 'ok') return updated;
      if (outcome === 'no_session') {
        throw new Error(`@openmaic/storage-pg: no session ${JSON.stringify(sessionId)}`);
      }
      // 'conflict'：并发改动，重读重试一次；再失败则响亮抛出
    }
    throw new Error(
      `@openmaic/storage-pg: session ${JSON.stringify(sessionId)} was concurrently modified`,
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.rpc.scalar('runtime_delete_session', { p_id: sessionId });
  }

  async appendRecord<TPayload extends RuntimePayload>(
    init: RuntimeRecordInit<TPayload>,
  ): Promise<RuntimeRecord<TPayload>> {
    // 预校验（seq 占位 0）在 rpc 之前（同 browser）。
    assertValid(
      validateRuntimeRecord({ ...init, seq: 0 }),
      `runtime record ${JSON.stringify(init.id)}`,
    );

    // 父会话守护 + 过期版本就地迁移（browser 在同一事务内做；这里 CAS 等价）。
    // rpc 内部的相等 CAS 是原子兜底，挡住预读到写入之间的 TOCTOU 窗口。
    let parent = await this.readSessionRow(init.sessionId);
    if (!parent) {
      throw new Error(`@openmaic/storage-pg: no session ${JSON.stringify(init.sessionId)}`);
    }
    if (isFutureRuntimeVersioned(sessionFromRow(parent))) {
      throw futureSessionError(init.sessionId, parent.runtime_dsl_version);
    }
    if (needsRuntimeMigration(sessionFromRow(parent))) {
      await this.readModifyWriteSession(init.sessionId, (s) => s);
      parent = (await this.readSessionRow(init.sessionId))!;
    }
    if (parent.status !== 'active') {
      throw new Error(
        `@openmaic/storage-pg: cannot append to session ${JSON.stringify(init.sessionId)} with ` +
          `status '${parent.status}' — records may only be appended to an active session`,
      );
    }

    const validator = this.validatorFor(parent.kind);
    if (validator) {
      assertValid(validator(init.payload), `runtime record ${JSON.stringify(init.id)}`);
    }

    let outcome: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      outcome = await this.rpc.scalar('runtime_append_record', {
        p_session_id: init.sessionId,
        p_id: init.id,
        p_scene_id: init.sceneId ?? '',
        p_action_index: init.actionIndex ?? -1,
        p_sub_anchor: init.subAnchor ?? '',
        p_created_at: init.createdAt,
        p_payload: JSON.stringify(init.payload === undefined ? null : init.payload),
        p_expect_revision: Number(parent.revision),
      });
      if (outcome !== 'conflict') break;
      // revision 在预读与写入之间被并发改动：重读裁决——未来版本响亮失败，
      // 否则按新 revision 重试一次
      const fresh = await this.readSessionRow(init.sessionId);
      if (!fresh) {
        throw new Error(`@openmaic/storage-pg: no session ${JSON.stringify(init.sessionId)}`);
      }
      if (isFutureRuntimeVersioned(sessionFromRow(fresh))) {
        throw futureSessionError(init.sessionId, fresh.runtime_dsl_version);
      }
      parent = fresh;
    }

    if (outcome === 'no_session') {
      throw new Error(`@openmaic/storage-pg: no session ${JSON.stringify(init.sessionId)}`);
    }
    if (outcome === 'conflict') {
      throw new Error(
        `@openmaic/storage-pg: session ${JSON.stringify(init.sessionId)} was concurrently modified`,
      );
    }
    if (outcome === 'inactive_session') {
      throw new Error(
        `@openmaic/storage-pg: cannot append to session ${JSON.stringify(init.sessionId)} ` +
          `— records may only be appended to an active session`,
      );
    }
    // 'ok'（新插入）或 'id_conflict'（幂等重放）：取回该 id 的行并逐字段比对
    const rows = await this.rpc.rows<RecordRow>('runtime_get_record', { p_id: init.id });
    const stored = rows[0];
    if (!stored) {
      throw new Error(
        `@openmaic/storage-pg: append outcome '${String(outcome)}' but record ${JSON.stringify(init.id)} is absent`,
      );
    }
    const echoMatches =
      stored.session_id === init.sessionId &&
      toIso(stored.created_at) === init.createdAt &&
      (stored.scene_id ?? undefined) === init.sceneId &&
      (stored.action_index ?? undefined) === init.actionIndex &&
      (stored.sub_anchor ?? undefined) === init.subAnchor &&
      deepEqual(stored.payload, init.payload === undefined ? null : init.payload);
    if (!echoMatches) {
      throw new Error(
        `@openmaic/storage-pg: IDEMPOTENCY_CONFLICT — record id ${JSON.stringify(init.id)} ` +
          `was already used with different content`,
      );
    }
    return recordFromRow<TPayload>(stored);
  }

  async listRecords(sessionId: string, opts?: { sceneId?: string }): Promise<RuntimeRecord[]> {
    const rows =
      opts?.sceneId === undefined
        ? await this.rpc.rows<RecordRow>('runtime_list_records', { p_session_id: sessionId })
        : await this.rpc.rows<RecordRow>('runtime_list_records_by_scene', {
            p_session_id: sessionId,
            p_scene_id: opts.sceneId,
          });
    return rows.map((r) => recordFromRow(r));
  }

  /**
   * 将某 learner 名下的过期版本会话逐行就地迁移到当前 DSL 版本。
   * 不在 RuntimeStore 契约内——供 API 层在 runtime_merge_with_grant 返回
   * 'version_conflict' 时调用（不核销 grant），迁移完成后由调用方重试原子
   * merge。未来版本行直接响亮失败（同 mergeLearner 的守护）。
   */
  async migrateLearnerRuntime(learnerKey: string): Promise<void> {
    const rows = await this.rpc.rows<SessionRow>('runtime_list_sessions_by_learner', {
      p_learner_key: learnerKey,
    });
    for (const row of rows) {
      const session = sessionFromRow(row);
      if (isFutureRuntimeVersioned(session)) {
        throw new Error(
          `@openmaic/storage-pg: cannot merge learner ${JSON.stringify(learnerKey)} — ` +
            `session ${JSON.stringify(row.id)} was written at a newer runtime DSL version`,
        );
      }
      if (needsRuntimeMigration(session)) {
        await this.readModifyWriteSession(row.id, (s) => s);
      }
    }
  }

  async mergeLearner(fromLearnerKey: string, toLearnerKey: string): Promise<number> {
    if (
      typeof fromLearnerKey !== 'string' ||
      fromLearnerKey === '' ||
      typeof toLearnerKey !== 'string' ||
      toLearnerKey === ''
    ) {
      throw new Error('@openmaic/storage-pg: learner keys must be non-empty strings');
    }
    if (fromLearnerKey === toLearnerKey) return 0;

    // browser 语义：整并原子——任一行是未来版本则整并不动（semver 守护在 TS 层，
    // SQL 只做相等判断）；过期版本先逐行就地迁移再合并。
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.migrateLearnerRuntime(fromLearnerKey);
      // learner 锁（runtime_learner_locks）使预读与搬移之间的并发变化不可能发生，
      // 因此以函数返回的真实移动数为准，不再比较预读行数（P0-2）。
      const outcome = String(
        await this.rpc.scalar('runtime_merge_learner', {
          p_from: fromLearnerKey,
          p_to: toLearnerKey,
          p_expect_version: RUNTIME_DSL_VERSION,
        }),
      );
      if (outcome.startsWith('ok:')) {
        return Number(outcome.slice('ok:'.length));
      }
      // 'version_conflict'：预读之后又有过期版本行并发插入（迁移窗口竞态）——
      // 重读后再次迁移并重试一次；再失败则响亮抛出
    }
    throw new Error(
      `@openmaic/storage-pg: learner ${JSON.stringify(fromLearnerKey)} was concurrently modified during merge`,
    );
  }

  async deleteLearnerRuntime(stageId: string, learnerKey: string): Promise<void> {
    await this.rpc.scalar('runtime_delete_learner_runtime', {
      p_stage_id: stageId,
      p_learner_key: learnerKey,
    });
  }

  async deleteStageRuntime(stageId: string): Promise<void> {
    await this.rpc.scalar('runtime_delete_stage_runtime', { p_stage_id: stageId });
  }
}
