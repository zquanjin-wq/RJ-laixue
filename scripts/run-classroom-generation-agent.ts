import { hostname } from 'node:os';
import { closeDatabasePool, getDatabasePool } from '@/lib/server/db/pool';
import { runDurableClassroomOnce } from '@/lib/server/durable-classroom-worker';

const intervalMs = Number.parseInt(process.env.CLASSROOM_GENERATION_INTERVAL_MS ?? '3000', 10);
const workerId =
  process.env.CLASSROOM_GENERATION_WORKER_ID?.trim() ||
  `classroom-agent:${hostname()}:${process.pid}`;
const configuredBaseUrl = process.env.BETTER_AUTH_URL?.trim() || process.env.APP_BASE_URL?.trim();

if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
  throw new Error('CLASSROOM_GENERATION_INTERVAL_MS must be at least 1000');
}
if (!configuredBaseUrl) {
  throw new Error('BETTER_AUTH_URL or APP_BASE_URL is required for classroom generation');
}

const baseUrl = new URL(configuredBaseUrl).origin;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

async function main() {
  while (!stopping) {
    try {
      const worked = await runDurableClassroomOnce(getDatabasePool(), workerId, baseUrl);
      if (!worked) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } catch (error) {
      console.error('[classroom-generation-agent] job failed', error);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  await closeDatabasePool();
}

void main().catch((error) => {
  console.error('[classroom-generation-agent] fatal', error);
  process.exitCode = 1;
});
