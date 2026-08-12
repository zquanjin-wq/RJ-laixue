export function safeNextPath(next: string | null): string {
  return next?.startsWith('/') && !next.startsWith('//') ? next : '/';
}
