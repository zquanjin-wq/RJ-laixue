import { describe, expect, it } from 'vitest';
import { safeNextPath } from '@/lib/utils/safe-next';

describe('safeNextPath', () => {
  it('keeps a normal in-app path', () => {
    expect(safeNextPath('/learn/token-1')).toBe('/learn/token-1');
  });

  it('falls back to home for external or malformed targets', () => {
    expect(safeNextPath('https://example.com')).toBe('/');
    expect(safeNextPath('//example.com')).toBe('/');
    expect(safeNextPath(null)).toBe('/');
  });
});
