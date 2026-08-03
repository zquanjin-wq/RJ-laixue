/**
 * Load .env.local before tests so API keys are available.
 * Also sets up fake-indexeddb so tests can import DB modules at the top level.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { IDBFactory } from 'fake-indexeddb';

// Dexie checks globalThis.indexedDB at module load time.
// Must be set before ANY business module is imported.
(globalThis as any).indexedDB = new IDBFactory();

// Dexie 4 checks for IDBKeyRange in its API detection.
// fake-indexeddb provides it as a named export.
import * as fakeIndexedDB from 'fake-indexeddb';
(globalThis as any).IDBKeyRange = (fakeIndexedDB as any).IDBKeyRange;
(globalThis as any).IDBCursor = (fakeIndexedDB as any).IDBCursor;
(globalThis as any).IDBTransaction = (fakeIndexedDB as any).IDBTransaction;

const envPath = resolve(__dirname, '..', '.env.local');
try {
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // .env.local not found, skip
}

// Browser-oriented unit tests import the Supabase client but do not contact a
// real project. Keep them hermetic when CI has no developer .env.local.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://unit-test.invalid.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'unit-test-anon-key';
