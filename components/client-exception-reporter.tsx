'use client';

import { useEffect } from 'react';

const MAX_MESSAGE_LENGTH = 800;
const MAX_STACK_LENGTH = 2_000;

function truncate(value: unknown, limit: number) {
  return typeof value === 'string' ? value.slice(0, limit) : undefined;
}

/**
 * Production client errors do not reach the application logger by default.
 * Keep this reporter deliberately small and best-effort: it is only used to
 * identify a crashing bundle / source location and never blocks the UI.
 */
export function ClientExceptionReporter() {
  useEffect(() => {
    const report = (message: unknown, stack?: unknown) => {
      const payload = {
        event: 'client_exception',
        pathname: window.location.pathname,
        search: window.location.search.slice(0, 200),
        message: truncate(message, MAX_MESSAGE_LENGTH) ?? 'Unknown client exception',
        stack: truncate(stack, MAX_STACK_LENGTH),
      };
      void fetch('/api/client-diagnostics', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => undefined);
    };

    const onError = (event: ErrorEvent) => report(event.message, event.error?.stack);
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      report(reason instanceof Error ? reason.message : String(reason), reason?.stack);
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  return null;
}
