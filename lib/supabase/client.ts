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

declare global {
  interface Window {
    __LAIXUE_RUNTIME_CONFIG__?: {
      supabaseUrl?: string;
      supabaseAnonKey?: string;
    };
  }
}

const runtimeConfig =
  typeof window === 'undefined' ? undefined : window.__LAIXUE_RUNTIME_CONFIG__;

// Dokploy supplies application environment variables when the container
// starts, while Next compiles browser bundles earlier. The layout provides
// these public values at request time so a normal runtime environment works
// without duplicating variables as Docker build arguments.
const supabaseUrl =
  runtimeConfig?.supabaseUrl || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://invalid.local';
const supabaseAnonKey =
  runtimeConfig?.supabaseAnonKey || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'build-placeholder';

export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey);
