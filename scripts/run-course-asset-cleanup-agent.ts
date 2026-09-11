import { hostname } from 'node:os';
import { closeDatabasePool } from '@/lib/server/db/pool';
import { runCourseAssetCleanup } from '@/lib/server/course-asset-cleanup';

const intervalMs = Number.parseInt(process.env.COURSE_ASSET_CLEANUP_INTERVAL_MS ?? '21600000', 10);
const maxAgeMs = Number.parseInt(process.env.COURSE_ASSET_CLEANUP_MAX_AGE_MS ?? '86400000', 10);
const limit = Number.parseInt(process.env.COURSE_ASSET_CLEANUP_LIMIT ?? '100', 10);
const workerId = process.env.COURSE_ASSET_CLEANUP_WORKER_ID?.trim() || `course-asset-cleanup:${hostname()}:${process.pid}`;

if (!Number.isFinite(intervalMs) || intervalMs < 60_000) {
  throw new Error('COURSE_ASSET_CLEANUP_INTERVAL_MS must be at least 60000');
}
if (!Number.isFinite(maxAgeMs) || maxAgeMs < 3_600_000) {
  throw new Error('COURSE_ASSET_CLEANUP_MAX_AGE_MS must be at least 3600000');
}
if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
  throw new Error('COURSE_ASSET_CLEANUP_LIMIT must be an integer between 1 and 1000');
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; });

async function runOnce() {
  const result = await runCourseAssetCleanup({ maxAgeMs, limit });
  console.info('[course-asset-cleanup]', { workerId, ...result });
}

async function main() {
  while (!stopping) {
    try {
      await runOnce();
    } catch (error) {
      console.error('[course-asset-cleanup] run failed', {
        workerId,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  await closeDatabasePool();
}

void main().catch((error) => {
  console.error('[course-asset-cleanup] fatal', error);
  process.exitCode = 1;
});
