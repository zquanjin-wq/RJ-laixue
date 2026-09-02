/**
 * Converts the value from an HTML datetime-local control into an absolute
 * timestamp before it crosses the browser/server boundary.
 */
export function toTaskTimestamp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
