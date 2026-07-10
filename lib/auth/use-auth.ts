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

async function ensureProfile(user: User): Promise<UserProfile> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, role, display_name')
    .eq('id', user.id)
    .maybeSingle();

  if (error) throw error;
  if (data) return data as UserProfile;

  const displayName =
    user.user_metadata?.display_name ||
    user.user_metadata?.name ||
    user.email?.split('@')[0] ||
    null;

  const { data: inserted, error: insertError } = await supabase
    .from('profiles')
    .insert({ id: user.id, role: 'learner', display_name: displayName })
    .select('id, role, display_name')
    .single();

  if (insertError) throw insertError;
  return inserted as UserProfile;
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
      const profile = user ? await ensureProfile(user) : null;

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

