/**
 * Spike shared helpers: MinerU Cloud v4 API utils.
 * DO NOT COMMIT — temporary Spike scripts only.
 *
 * Usage:
 *   MINERU_API_KEY=sk-xxx npx tsx scripts/spike-async-mineru/spike-a1-url-mode.ts
 */

const MINERU_API_KEY = process.env.MINERU_API_KEY;
if (!MINERU_API_KEY) {
  console.error('❌ MINERU_API_KEY env var is required');
  process.exit(1);
}

const MINERU_BASE = 'https://mineru.net/api/v4';
const POLL_INTERVAL = 3_000; // 3s
const POLL_MAX = 15 * 60 * 1_000; // 15 min

interface MinerUEnvelope<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

export function authHeader() {
  return { Authorization: `Bearer ${MINERU_API_KEY}` };
}

export async function readMinerUJson<T>(res: Response, ctx: string): Promise<T> {
  const text = await res.text();
  let json: MinerUEnvelope<T>;
  try {
    json = JSON.parse(text) as MinerUEnvelope<T>;
  } catch {
    throw new Error(`MinerU ${ctx}: invalid JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (json.code !== 0) {
    throw new Error(`MinerU ${ctx}: ${json.msg} (code ${json.code})`);
  }
  return json.data;
}

export async function createBatch(files: Array<{ name: string }>) {
  const res = await fetch(`${MINERU_BASE}/file-urls/batch`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files,
      enable_formula: true,
      enable_table: true,
      model_version: 'vlm',
      language: 'ch',
    }),
  });
  return readMinerUJson<{ batch_id: string; file_urls?: string[]; files?: string[] }>(
    res,
    'file-urls/batch',
  );
}

export async function createTaskBatch(files: Array<{ url: string; is_ocr?: boolean; data_id?: string }>) {
  const res = await fetch(`${MINERU_BASE}/extract/task/batch`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  });
  return readMinerUJson<{ batch_id: string }>(res, 'extract/task/batch');
}

export async function pollBatch(batchId: string, maxMs = POLL_MAX) {
  const deadline = Date.now() + maxMs;
  let lastState = '';

  while (Date.now() < deadline) {
    const res = await fetch(`${MINERU_BASE}/extract-results/batch/${batchId}`, {
      headers: { ...authHeader(), Accept: 'application/json' },
    });
    const data = await readMinerUJson<{
      extract_result?: { state?: string; full_zip_url?: string; err_msg?: string; file_name?: string } | Array<{ state?: string; full_zip_url?: string; err_msg?: string; file_name?: string }>;
    }>(res, 'extract-results/batch');

    const rows = Array.isArray(data.extract_result) ? data.extract_result : data.extract_result ? [data.extract_result] : [];
    const row = rows[0];

    if (!row?.state) {
      await sleep(POLL_INTERVAL);
      continue;
    }

    if (row.state !== lastState) {
      lastState = row.state;
      console.log(`  → state: ${row.state}`);
    }

    if (row.state === 'failed') {
      throw new Error(`MinerU failed: ${row.err_msg || 'unknown'}`);
    }

    if (row.state === 'done' && row.full_zip_url) {
      return row;
    }

    await sleep(POLL_INTERVAL);
  }

  throw new Error(`Poll timeout after ${maxMs / 1000}s`);
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
