const endpoint = process.env.COURSE_REVOICE_URL;
const secret = process.env.CRON_SECRET;
const intervalMs = Number.parseInt(process.env.COURSE_REVOICE_INTERVAL_MS ?? '60000', 10);

if (!endpoint) throw new Error('COURSE_REVOICE_URL is required');
if (!secret) throw new Error('CRON_SECRET is required');
if (!Number.isFinite(intervalMs) || intervalMs < 1_000) {
  throw new Error('COURSE_REVOICE_INTERVAL_MS must be at least 1000');
}

async function runBatch() {
  try {
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(290_000),
    });
    if (!response.ok) throw new Error(`Revoice worker returned HTTP ${response.status}`);
    const payload = await response.json();
    console.info('[course-revoice-worker] batch completed', {
      jobId: payload?.job?.id ?? null,
      status: payload?.job?.status ?? null,
    });
  } catch (error) {
    console.error('[course-revoice-worker] batch failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

await runBatch();
setInterval(() => void runBatch(), intervalMs);
