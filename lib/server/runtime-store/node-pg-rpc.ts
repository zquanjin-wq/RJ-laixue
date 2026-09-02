import type { Pool } from 'pg';
import type { RuntimeStoreRpcClient } from './pg';

const parameters: Record<string, string[]> = {
  runtime_create_session: [
    'p_id',
    'p_version',
    'p_kind',
    'p_stage_id',
    'p_learner_key',
    'p_status',
    'p_created_at',
    'p_updated_at',
  ],
  runtime_get_session: ['p_id'],
  runtime_list_sessions: ['p_stage_id', 'p_learner_key'],
  runtime_list_sessions_by_learner: ['p_learner_key'],
  runtime_update_session: [
    'p_id',
    'p_version',
    'p_kind',
    'p_stage_id',
    'p_learner_key',
    'p_status',
    'p_created_at',
    'p_updated_at',
    'p_expect_revision',
  ],
  runtime_append_record: [
    'p_session_id',
    'p_id',
    'p_scene_id',
    'p_action_index',
    'p_sub_anchor',
    'p_created_at',
    'p_payload',
    'p_expect_revision',
  ],
  runtime_list_records: ['p_session_id'],
  runtime_list_records_by_scene: ['p_session_id', 'p_scene_id'],
  runtime_get_record: ['p_id'],
  runtime_delete_session: ['p_id'],
  runtime_delete_learner_runtime: ['p_stage_id', 'p_learner_key'],
  runtime_delete_stage_runtime: ['p_stage_id'],
  runtime_merge_learner: ['p_from', 'p_to', 'p_expect_version'],
  runtime_merge_with_grant: ['p_grant_id', 'p_from', 'p_to', 'p_expect_version', 'p_now'],
};

export function createNodePgRuntimeClient(pool: Pool): RuntimeStoreRpcClient {
  function call(fn: string, args: Record<string, unknown>) {
    const names = parameters[fn];
    if (!names) throw new Error(`Unknown runtime database operation: ${fn}`);
    const placeholders = names.map((_, index) => `$${index + 1}`).join(', ');
    return pool.query(
      `SELECT * FROM runtime.${fn}(${placeholders})`,
      names.map((name) => args[name]),
    );
  }

  return {
    async scalar(fn, args) {
      const result = await call(fn, args);
      const row = result.rows[0];
      return row ? Object.values(row)[0] : null;
    },
    async rows<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
      return (await call(fn, args)).rows as T[];
    },
  };
}
