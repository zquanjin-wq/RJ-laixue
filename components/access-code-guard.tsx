'use client';

import { useEffect, useState, ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { AccessCodeModal } from '@/components/access-code-modal';

// Paths that should bypass the access-code gate even when the operator has
// ACCESS_CODE set. These pages are reference material intended to be reachable
// without friction (e.g. the public-facing user manual for teachers).
const ACCESS_CODE_EXEMPT_PATHS = ['/docs'];

function isAccessCodeExempt(pathname: string | null): boolean {
  if (!pathname) return false;
  return ACCESS_CODE_EXEMPT_PATHS.some(
    (exempt) => pathname === exempt || pathname.startsWith(`${exempt}/`),
  );
}

export function AccessCodeGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const exempt = isAccessCodeExempt(pathname);
  const [status, setStatus] = useState<{
    enabled: boolean;
    authenticated: boolean;
    loading: boolean;
  }>({ enabled: false, authenticated: false, loading: true });

  useEffect(() => {
    if (exempt) return;
    let cancelled = false;
    fetch('/api/access-code/status')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          setStatus({
            enabled: data.enabled,
            authenticated: data.authenticated,
            loading: false,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Default to requiring auth on error — safer than silently disabling
          setStatus({ enabled: true, authenticated: false, loading: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [exempt]);

  const needsAuth = !exempt && !status.loading && status.enabled && !status.authenticated;

  return (
    <>
      {needsAuth && (
        <AccessCodeModal
          open={true}
          onSuccess={() => setStatus((s) => ({ ...s, authenticated: true }))}
        />
      )}
      {children}
    </>
  );
}
