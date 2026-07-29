/**
 * lib/server/runtime-store/request-context.ts
 *
 * RJ-contract-v1 routes 的共享上下文：
 *   - requireRuntimeUser()：任何登录角色都可用运行时接口（learner 是主写入方），
 *     learnerKey 一律由服务端取 auth.uid()，客户端自报的一律忽略（拍板的安全决策）；
 *   - makeRuntimeStore()：service role 的 RuntimeStorePg 实例。
 */
import { requireAuthOrTeacher, type AuthResult } from '@/lib/server/api-guard';
import { getServiceSupabase } from '@/lib/supabase/server';
import { RuntimeStorePg } from './pg';
import { createSupabaseRpcClient } from './supabase-rpc';

/** 运行时数据接口对全部登录角色开放（学员是主写入方）。 */
export async function requireRuntimeUser(): Promise<AuthResult> {
  return requireAuthOrTeacher(['learner', 'teacher', 'admin']);
}

export function makeRuntimeStore(): RuntimeStorePg {
  return new RuntimeStorePg(createSupabaseRpcClient(getServiceSupabase()));
}
