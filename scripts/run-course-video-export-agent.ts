import { hostname } from 'node:os';
import { closeDatabasePool } from '@/lib/server/db/pool';
import { runNextCourseVideoExport } from '@/lib/server/course-video-export-worker';

const intervalMs = Number.parseInt(process.env.COURSE_VIDEO_EXPORT_INTERVAL_MS ?? '5000', 10);
const leaseMs = Number.parseInt(process.env.COURSE_VIDEO_EXPORT_LEASE_MS ?? '300000', 10);
const workerId = process.env.COURSE_VIDEO_EXPORT_WORKER_ID?.trim() || `video-agent:${hostname()}:${process.pid}`;

if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
  throw new Error('COURSE_VIDEO_EXPORT_INTERVAL_MS must be at least 1000');
}
if (!Number.isFinite(leaseMs) || leaseMs < 30_000) {
  throw new Error('COURSE_VIDEO_EXPORT_LEASE_MS must be at least 30000');
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

async function main() {
  while (!stopping) {
    try {
      const claimed = await runNextCourseVideoExport({ workerId, leaseMs });
      if (!claimed) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } catch (error) {
      console.error('[course-video-export-agent] job failed', error);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  await closeDatabasePool();
}

void main().catch((error) => {
  console.error('[course-video-export-agent] fatal', error);
  process.exitCode = 1;
});
