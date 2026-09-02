'use client';

import { useCallback, useEffect, useState } from 'react';
import { authClient } from './client';

export type UserRole = 'admin' | 'teacher' | 'learner';

export interface UserProfile {
  id: string;
  role: UserRole;
  display_name: string | null;
}

interface AuthUser {
  id: string;
  email: string;
  name: string;
}

interface AuthState {
  user: AuthUser | null;
  session: { user: AuthUser } | null;
  profile: UserProfile | null;
  loading: boolean;
  error: string | null;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    session: null,
    profile: null,
    loading: true,
    error: null,
  });

  const loadSession = useCallback(async (showLoading = true) => {
    if (showLoading) setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const sessionResult = await authClient.getSession();
      if (sessionResult.error) throw sessionResult.error;
      if (!sessionResult.data) {
        setState({ user: null, session: null, profile: null, loading: false, error: null });
        return;
      }

      const response = await fetch('/api/me', { cache: 'no-store' });
      if (!response.ok) throw new Error('Failed to load account profile');
      const payload = (await response.json()) as {
        actor: {
          userId: string;
          email: string;
          name: string;
          role: UserRole;
          mustChangePassword: boolean;
        };
      };
      const user: AuthUser = {
        id: payload.actor.userId,
        email: payload.actor.email,
        name: payload.actor.name,
      };
      setState({
        user,
        session: { user },
        profile: { id: user.id, role: payload.actor.role, display_name: user.name },
        loading: false,
        error: null,
      });
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
    void loadSession();
    const refresh = () => void loadSession(false);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [loadSession]);

  const signOut = useCallback(async () => {
    await authClient.signOut();
    setState({ user: null, session: null, profile: null, loading: false, error: null });
  }, []);

  return { ...state, signOut, reload: loadSession };
}
