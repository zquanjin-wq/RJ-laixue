import { describe, expect, it } from 'vitest';
import { toTaskTimestamp } from '@/lib/utils/task-datetime';

describe('toTaskTimestamp', () => {
  it('turns a datetime-local value into an absolute timestamp', () => {
    expect(toTaskTimestamp('2026-08-12T11:48')).toMatch(/2026-08-12T/);
  });

  it('keeps an empty time optional', () => {
    expect(toTaskTimestamp('')).toBeUndefined();
  });
});
