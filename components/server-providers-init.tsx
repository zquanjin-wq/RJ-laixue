'use client';

import { useEffect } from 'react';
import { useAuth } from '@/lib/auth/use-auth';
import { useSettingsStore } from '@/lib/store/settings';

/**
 * Fetches server-configured providers on mount and merges into settings store.
 * Renders nothing — purely a side-effect component.
 */
export function ServerProvidersInit() {
  const { loading, profile } = useAuth();
  const fetchServerProviders = useSettingsStore((state) => state.fetchServerProviders);

  useEffect(() => {
    if (loading || !profile) return;
    fetchServerProviders();
  }, [fetchServerProviders, loading, profile]);

  return null;
}
