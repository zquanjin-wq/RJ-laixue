/**
 * lib/server/runtime-store/supabase-rpc.ts
 *
 * RuntimeStoreRpcClient 的生产实现：Supabase service client 的 PostgREST rpc。
 * 具名参数与 supabase-runtime-store-v1.sql 的函数签名一一对应。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RuntimeStoreRpcClient } from './pg';

export function createSupabaseRpcClient(supabase: SupabaseClient): RuntimeStoreRpcClient {
  return {
    async scalar(fn, args) {
      const { data, error } = await supabase.rpc(fn, args);
      if (error) {
        throw new Error(`@openmaic/storage-pg: rpc ${fn} failed: ${error.message}`);
      }
      return data;
    },
    async rows<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
      const { data, error } = await supabase.rpc(fn, args);
      if (error) {
        throw new Error(`@openmaic/storage-pg: rpc ${fn} failed: ${error.message}`);
      }
      return (data ?? []) as T[];
    },
  };
}
