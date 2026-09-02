import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'supabase-learning-tasks-gate2b.sql'), 'utf8');
const hotfix = readFileSync(
  resolve(process.cwd(), 'supabase-learning-tasks-gate2b-publish-hotfix.sql'),
  'utf8',
);

describe('task package publish token generation', () => {
  it('uses the configured extensions schema for pgcrypto', () => {
    expect(source).toContain('extensions.gen_random_bytes(16)');
    expect(hotfix).toContain('extensions.gen_random_bytes(16)');
  });
});
