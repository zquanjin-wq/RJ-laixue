const intervalMs = Number(process.env.COURSE_VIDEO_EXPORT_INTERVAL_MS ?? 5000);
const endpoint = process.env.COURSE_VIDEO_EXPORT_WORKER_URL;

if (!endpoint) throw new Error('COURSE_VIDEO_EXPORT_WORKER_URL is required');
if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
  throw new Error('COURSE_VIDEO_EXPORT_INTERVAL_MS must be at least 1000');
}

async function tick() {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.COURSE_VIDEO_EXPORT_WORKER_TOKEN ?? ''}` },
    // A hung app request must not freeze this worker's polling loop forever.
    signal: AbortSignal.timeout(290_000),
  });
  if (!response.ok) throw new Error(`video export worker endpoint failed: ${response.status}`);
}

for (;;) {
  try { await tick(); } catch (error) { console.error('[course-video-export-worker]', error); }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
