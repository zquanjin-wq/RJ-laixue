'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase/client';

export type UserRole = 'admin' | 'learner';

export interface UserProfile {
  id: string;
  role: UserRole;
  display_name: string | null;
}

interface AuthState {
  user: User | null;
  session: Session | null;
  profile: UserProfile | null;
  loading: boolean;
  error: string | null;
}

/**
 * Read the profile for the signed-in user.
 *
 * Profile creation is owned exclusively by the database trigger
 * `trg_handle_new_user` (see supabase-auth-triggers.sql). This
 * function never inserts into profiles — if the row is missing we
 * return null and let `onAuthStateChange` retry shortly after.
 */
async function fetchProfile(user: User): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, role, display_name')
    .eq('id', user.id)
    .maybeSingle();

  if (error) throw error;
  return (data as UserProfile | null) ?? null;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    session: null,
    profile: null,
    loading: true,
    error: null,
  });

  const loadSession = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;

      const session = data.session;
      const user = session?.user ?? null;
      const profile = user ? await fetchProfile(user) : null;

      setState({ user, session, profile, loading: false, error: null });
    } catch (error) {
      setState({
        user: null,
        session: null,
        profile: null,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to load session',
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!cancelled) await loadSession();
    };
    load();

    const { data } = supabase.auth.onAuthStateChange(() => {
      loadSession();
    });

    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, [loadSession]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setState({ user: null, session: null, profile: null, loading: false, error: null });
  }, []);

  return { ...state, signOut, reload: loadSession };
}

