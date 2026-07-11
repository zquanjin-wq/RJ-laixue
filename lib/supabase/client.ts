/**
 * lib/supabase/client.ts
 *
 * Browser-side Supabase client. The session MUST live in cookies so
 * server components can read it via next/headers — otherwise RSC at
 * /admin etc. always sees an anonymous request and redirects to
 * /login even after a successful signIn on the client.
 *
 * createBrowserClient (from @supabase/ssr) writes the session to
 * cookies on the client. The cookie name is the same shape that
 * getServerSupabase() reads in RSC, so sign-in on the client is
 * immediately visible to the next server request.
 */
import { createBrowserClient } from '@supabase/ssr';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!supabaseUrl || !supabaseAnonKey) {
  // This branch is hit at build time if env is missing. Throw early
  // so the error is loud rather than producing a broken client.
  throw new Error(
    'Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
      'Check .env.local or Vercel env.',
  );
}

export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey);