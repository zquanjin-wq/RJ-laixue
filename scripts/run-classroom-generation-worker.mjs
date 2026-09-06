const endpoint = process.env.CLASSROOM_GENERATION_WORKER_URL;
const secret = process.env.CRON_SECRET;
const intervalMs = Number.parseInt(process.env.CLASSROOM_GENERATION_INTERVAL_MS ?? '3000', 10);

if (!endpoint) throw new Error('CLASSROOM_GENERATION_WORKER_URL is required');
if (!secret) throw new Error('CRON_SECRET is required');
if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
  throw new Error('CLASSROOM_GENERATION_INTERVAL_MS must be at least 1000');
}

async function tick() {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(290_000),
  });
  if (!response.ok) throw new Error(`classroom worker returned HTTP ${response.status}`);
}

for (;;) {
  try {
    await tick();
  } catch (error) {
    console.error(
      '[classroom-generation-worker] batch failed',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
