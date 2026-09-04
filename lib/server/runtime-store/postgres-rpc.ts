import type { Pool } from 'pg';
import type { RuntimeStoreRpcClient } from './pg';

const FUNCTION_ARGS: Record<string, string[]> = {
  runtime_create_session: ['p_id', 'p_version', 'p_kind', 'p_stage_id', 'p_learner_key', 'p_status', 'p_created_at', 'p_updated_at'],
  runtime_get_session: ['p_id'],
  runtime_list_sessions: ['p_stage_id', 'p_learner_key'],
  runtime_list_sessions_by_learner: ['p_learner_key'],
  runtime_update_session: ['p_id', 'p_version', 'p_kind', 'p_stage_id', 'p_learner_key', 'p_status', 'p_created_at', 'p_updated_at', 'p_expect_revision'],
  runtime_append_record: ['p_session_id', 'p_id', 'p_scene_id', 'p_action_index', 'p_sub_anchor', 'p_created_at', 'p_payload', 'p_expect_revision'],
  runtime_list_records: ['p_session_id'],
  runtime_list_records_by_scene: ['p_session_id', 'p_scene_id'],
  runtime_get_record: ['p_id'],
  runtime_delete_session: ['p_id'],
  runtime_delete_learner_runtime: ['p_stage_id', 'p_learner_key'],
  runtime_delete_stage_runtime: ['p_stage_id'],
  runtime_merge_learner: ['p_from', 'p_to', 'p_expect_version'],
  runtime_merge_with_grant: ['p_grant_id', 'p_from', 'p_to', 'p_expect_version', 'p_now'],
};

function call(name: string, args: Record<string, unknown>) {
  const keys = FUNCTION_ARGS[name];
  if (!keys) throw new Error(`Unsupported runtime function: ${name}`);
  return { name, values: keys.map((key) => args[key]), placeholders: keys.map((_, index) => `$${index + 1}`).join(', ') };
}

export function createPostgresRpcClient(pool: Pool): RuntimeStoreRpcClient {
  return {
    async scalar(name, args) {
      const invocation = call(name, args);
      const result = await pool.query<{ value: unknown }>(
        `SELECT runtime.${invocation.name}(${invocation.placeholders}) AS value`,
        invocation.values,
      );
      return result.rows[0]?.value;
    },
    async rows<T>(name: string, args: Record<string, unknown>): Promise<T[]> {
      const invocation = call(name, args);
      const result = await pool.query<T>(
        `SELECT * FROM runtime.${invocation.name}(${invocation.placeholders})`,
        invocation.values,
      );
      return result.rows;
    },
  };
}
