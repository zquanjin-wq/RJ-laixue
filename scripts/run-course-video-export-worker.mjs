const intervalMs = Number(process.env.COURSE_VIDEO_EXPORT_INTERVAL_MS ?? 5000);
const endpoint = process.env.COURSE_VIDEO_EXPORT_WORKER_URL;

if (!endpoint) throw new Error('COURSE_VIDEO_EXPORT_WORKER_URL is required');

async function tick() {
  const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${process.env.COURSE_VIDEO_EXPORT_WORKER_TOKEN ?? ''}` } });
  if (!response.ok) throw new Error(`video export worker endpoint failed: ${response.status}`);
}

for (;;) {
  try { await tick(); } catch (error) { console.error('[course-video-export-worker]', error); }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
