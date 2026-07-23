/**
 * lib/server/api-guard.ts
 *
 * 共享的 API 鉴权 + 频率限制工具，给所有需要保护的 /api/* 路由用。
 *
 * 三件事：
 *   1. requireAuthOrTeacher(role?)：登录校验 + 可选角色校验
 *   2. rateLimitByUser(userId, key, max, windowMs)：基于用户 ID 的内存限速
 *   3. auditLog(eventName, payload)：统一审计日志前缀
 *
 * 为什么用内存 Map 而不是 Redis：
 *   - 单 Vercel 实例下足够；多实例场景再换 Redis
 *   - 不引入外部依赖
 *   - 限速目的是"挡脚本"，不是"精确计费"
 *
 * 已知限制：
 *   - Vercel 每实例独立，攻击者撞到不同实例可绕过；这是 best-effort
 *   - 进程重启后 Map 清零
 *   - 内存会缓慢增长（key 数 = 累计用户数 × 路由数），但远未到 OOM
 *
 * 用法示例：
 *   const guard = await requireAuthOrTeacher(['teacher', 'admin']);
 *   if (!guard.ok) return guard.response;
 *   const rl = rateLimitByUser(guard.user.id, 'generate-classroom', 5, 60_000);
 *   if (!rl.ok) return rl.response;
 *   // ... 业务逻辑
 */
import { type NextResponse } from 'next/server';
import { NextResponse as NextResponseConstructor } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { createLogger } from '@/lib/logger';
import { apiError } from '@/lib/server/api-response';

const log = createLogger('API Guard');

export type UserRole = 'admin' | 'teacher' | 'learner';

export interface AuthSuccess {
  ok: true;
  user: { id: string; email?: string | null };
  role: UserRole;
}

export interface AuthFailure {
  ok: false;
  response: NextResponse;
}

export type AuthResult = AuthSuccess | AuthFailure;

/**
 * 校验当前请求是否登录，并可选地校验角色。
 * 未登录 → 401；登录但角色不符 → 403。
 *
 * 调用方使用方式：
 *   const guard = await requireAuthOrTeacher();
 *   if (!guard.ok) return guard.response;
 *   const { user, role } = guard;
 */
export async function requireAuthOrTeacher(
  allowedRoles: UserRole[] = ['teacher', 'admin'],
): Promise<AuthResult> {
  let serverSupabase;
  try {
    serverSupabase = await getServerSupabase();
  } catch (e) {
    log.error('requireAuthOrTeacher: failed to init server supabase:', e);
    return {
      ok: false,
      response: apiError('SERVER_MISCONFIG', 500, 'Server supabase unavailable'),
    };
  }

  const {
    data: { user },
  } = await serverSupabase.auth.getUser();

  if (!user) {
    return {
      ok: false,
      response: apiError('UNAUTHENTICATED', 401, '请先登录后再使用该功能。'),
    };
  }

  // 角色校验。service_role 查 profiles 表（RLS 允许 user 读自己的 profile）。
  const { data: profile, error: profileErr } = await serverSupabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (profileErr) {
    log.error('requireAuthOrTeacher: profile lookup failed:', profileErr);
    return {
      ok: false,
      response: apiError('PROFILE_LOOKUP_FAILED', 500, 'Failed to load user role'),
    };
  }

  const role = (profile?.role ?? 'learner') as UserRole;
  if (!allowedRoles.includes(role)) {
    log.warn('requireAuthOrTeacher: role not in allow-list', {
      userId: user.id,
      role,
      allowedRoles,
    });
    return {
      ok: false,
      response: apiError(
        'FORBIDDEN',
        403,
        `该接口仅限 ${allowedRoles.join(' / ')} 角色使用。`,
      ),
    };
  }

  return { ok: true, user: { id: user.id, email: user.email }, role };
}

// ── 频率限制 ─────────────────────────────────────────────────────

/**
 * 内存 Map 形式的频率限制。
 *
 * key 形如 `${userId}::${bucketKey}`，每个 bucket 独立计数。
 *
 * 进程内 Map，Vercel 多实例不共享——这是 best-effort 防刷，不替代
 * 上游 WAF / Cloudflare 限速。攻击者撞到不同实例可能绕过 1 倍配额，
 * 但攻击成本大幅上升。
 */
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

export interface RateLimitSuccess {
  ok: true;
  remaining: number;
}

export interface RateLimitFailure {
  ok: false;
  response: NextResponse;
}

export type RateLimitResult = RateLimitSuccess | RateLimitFailure;

/**
 * 同 userId 同 bucketKey 在 windowMs 内最多 max 次。
 * 默认：60 秒 5 次（用户给的 spec）。
 */
export function rateLimitByUser(
  userId: string,
  bucketKey: string,
  max: number = 5,
  windowMs: number = 60_000,
): RateLimitResult {
  const key = `${userId}::${bucketKey}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: max - 1 };
  }

  if (entry.count >= max) {
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    log.warn('rateLimitByUser: limit exceeded', {
      userId,
      bucketKey,
      count: entry.count,
      max,
      retryAfterSec,
    });
    // apiError 签名只接受 string details，但 429 需要 Retry-After header
    // 让浏览器/CDN 能正确退避。手动构造 NextResponse 一次。
    return {
      ok: false,
      response: NextResponseConstructor.json(
        {
          success: false,
          errorCode: 'RATE_LIMITED',
          error: `调用过于频繁，请 ${retryAfterSec} 秒后再试。`,
          details: `max=${max}, windowMs=${windowMs}, retryAfterSec=${retryAfterSec}`,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(retryAfterSec),
            'X-RateLimit-Limit': String(max),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.ceil(entry.resetAt / 1000)),
          },
        },
      ),
    };
  }

  entry.count++;
  return { ok: true, remaining: max - entry.count };
}

// 周期性清理过期条目，避免 Map 无限增长。
// 每 5 分钟清理一次——清理逻辑轻量，跑在 Node 内存，不阻塞请求。
// 仅在 module 第一次 load 时启动一次。Next.js dev hot reload 会重复
// import 这个模块，所以用 globalThis 做 idempotent 标记。
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
declare global {
  var __rj_laixue_rate_limit_cleanup_started: boolean | undefined;
}
if (typeof setInterval !== 'undefined' && !globalThis.__rj_laixue_rate_limit_cleanup_started) {
  globalThis.__rj_laixue_rate_limit_cleanup_started = true;
  const cleanup = () => {
    const now = Date.now();
    let removed = 0;
    for (const [k, v] of rateLimitMap.entries()) {
      if (now >= v.resetAt) {
        rateLimitMap.delete(k);
        removed++;
      }
    }
    if (removed > 0) log.info('rateLimitByUser: cleanup', { removed, size: rateLimitMap.size });
  };
  // Node 默认 unref，进程退出时不会卡住。
  setInterval(cleanup, CLEANUP_INTERVAL_MS).unref?.();
}
