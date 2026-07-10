/**
 * lib/supabase/server.ts
 *
 * Server-side Supabase clients for the Next.js App Router.
 *
 * Two flavours:
 *   - getServerSupabase(): cookie-bound, uses the anon key. Returns the
 *     signed-in user via cookie-based session, and respects RLS the
 *     same way the browser client does. Use this in route handlers,
 *     server actions, and React Server Components that need to act
 *     "as the user".
 *
 *   - getServiceSupabase(): uses SUPABASE_SERVICE_ROLE_KEY. Bypasses
 *     RLS. Use ONLY for trusted admin operations (student redemption,
 *     future /api/admin/* endpoints). MUST NEVER be imported from a
 *     client component or returned to the browser.
 *
 * Pair with: lib/supabase/client.ts (browser single-instance), and
 * supabase-auth-triggers.sql for the profile-creation triggers that
 * make the redemption flow possible.
 */
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A per-request server client bound to the active cookie session.
 *
 * `await cookies()` is required in Next.js 15+/16 because the
 * cookies() helper returns a Promise.
 */
export async function getServerSupabase(): Promise<SupabaseClient> {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey =
    process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      '[getServerSupabase] Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) ' +
        'and/or SUPABASE_ANON_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY).',
    );
  }

  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(items) {
        // Route handlers / server actions can set cookies here.
        // RSC evaluation throws — swallow that case; subsequent
        // session refresh happens on the next request.
        try {
          for (const { name, value, options } of items) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // no-op
        }
      },
    },
  });
}

/**
 * Service-role client. Bypasses RLS.
 *
 * MUST NOT be imported in client components. NEVER serialize the
 * resulting client and never echo service_role data back to the
 * browser unless you have re-enforced authorization in the caller.
 */
export function getServiceSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      '[getServiceSupabase] Missing SUPABASE_SERVICE_ROLE_KEY (or ' +
        'SUPABASE_URL). This client is server-only — set the env var on ' +
        'Vercel / .env.local and never expose it to the browser.',
    );
  }

  // Lazy require keeps the import graph clean for edge bundles.
  // Note: dynamic require is allowed in CommonJS, but we are inside
  // an ESM project — use top-level import below.
  const { createClient } = require('@supabase/supabase-js');
  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
