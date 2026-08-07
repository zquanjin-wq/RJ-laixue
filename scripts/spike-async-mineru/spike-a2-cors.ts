/**
 * Spike A2: Browser direct PUT to MinerU presigned URL (CORS test).
 *
 * Tests whether a browser (Origin: https://www.laixue.work) can directly
 * PUT a file to MinerU's presigned OSS upload URL without CORS rejection.
 *
 * Step 1: Create batch → get presigned URL
 * Step 2: Simulate browser preflight (OPTIONS) to presigned URL
 * Step 2b: Simulate browser PUT with Origin header
 *
 * Usage:
 *   MINERU_API_KEY=sk-xxx npx tsx scripts/spike-async-mineru/spike-a2-cors.ts
 */

import { authHeader, createBatch, readMinerUJson } from './shared';

const OUR_ORIGIN = 'https://www.laixue.work';
const MINERU_BASE = 'https://mineru.net/api/v4';

async function main() {
  console.log('=== Spike A2: Browser CORS → MinerU presigned URL ===\n');

  // Step 1: Create batch → get presigned upload URL
  console.log('1. Creating batch...');
  const batch = await createBatch([{ name: 'spike-test.pdf' }]);
  const uploadUrls = batch.file_urls ?? batch.files ?? [];
  if (!batch.batch_id || !uploadUrls.length) {
    console.error('❌ Failed to get presigned URL');
    process.exit(1);
  }
  console.log(`   batch_id: ${batch.batch_id}`);
  const presignedUrl = uploadUrls[0];
  console.log(`   presigned URL: ${presignedUrl.slice(0, 80)}...`);

  // Step 2: Simulate browser CORS preflight (OPTIONS)
  console.log('\n2. Testing CORS preflight (OPTIONS)...');
  try {
    const preflight = await fetch(presignedUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: OUR_ORIGIN,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    console.log(`   OPTIONS status: ${preflight.status}`);
    console.log(`   Access-Control-Allow-Origin: ${preflight.headers.get('access-control-allow-origin') || '(missing)'}`);
    console.log(`   Access-Control-Allow-Methods: ${preflight.headers.get('access-control-allow-methods') || '(missing)'}`);
    
    const corsAllowed = preflight.headers.get('access-control-allow-origin');
    if (corsAllowed === '*' || corsAllowed === OUR_ORIGIN) {
      console.log('   ✅ CORS preflight PASSED');
    } else {
      console.log('   ❌ CORS preflight FAILED — browser cannot PUT directly');
    }
  } catch (e) {
    console.error(`   ❌ OPTIONS request failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Step 2b: Test actual PUT with Origin header (simulating browser request)
  console.log('\n3. Testing browser-simulated PUT (with Origin header)...');
  try {
    const testFile = Buffer.from('%PDF-1.0\ntest\n%%EOF');
    const putRes = await fetch(presignedUrl, {
      method: 'PUT',
      headers: {
        Origin: OUR_ORIGIN,
        'Content-Type': 'application/pdf',
      },
      body: new Blob([testFile]),
    });
    console.log(`   PUT status: ${putRes.status}`);
    if (putRes.ok) {
      console.log('   ✅ PUT with Origin header PASSED');
    } else {
      const text = await putRes.text().catch(() => '');
      console.log(`   ❌ PUT failed: HTTP ${putRes.status} — ${text.slice(0, 200)}`);
    }
  } catch (e) {
    console.error(`   ❌ PUT request failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Step 2c: Test without Origin (server-side style — our existing behavior for comparison)
  console.log('\n4. Testing server-style PUT (no Origin, as Vercel would do)...');
  try {
    const testFile2 = Buffer.from('%PDF-1.0\ntest2\n%%EOF');
    const putRes = await fetch(presignedUrl, {
      method: 'PUT',
      body: new Blob([testFile2]),
    });
    console.log(`   PUT status: ${putRes.status}`);
    if (putRes.ok) {
      console.log('   ✅ Server-style PUT PASSED (baseline)');
      // Clean up: poll batch to completion (or delete)
      console.log('\n5. Polling batch to verify upload was received...');
      await pollBatchQuick(batch.batch_id);
    } else {
      const text = await putRes.text().catch(() => '');
      console.log(`   ❌ Server-style PUT failed: HTTP ${putRes.status} — ${text.slice(0, 200)}`);
    }
  } catch (e) {
    console.error(`   ❌ PUT request failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log('\n=== Spike A2 complete ===');
}

async function pollBatchQuick(batchId: string) {
  const res = await fetch(`${MINERU_BASE}/extract-results/batch/${batchId}`, {
    headers: { ...authHeader(), Accept: 'application/json' },
  });
  const data = await readMinerUJson<any>(res, 'poll check');
  const rows = Array.isArray(data.extract_result) ? data.extract_result : [data.extract_result];
  console.log(`   Batch state: ${rows[0]?.state || 'unknown'}`);
  if (rows[0]?.state === 'done') {
    console.log('   ✅ MinerU received and processed the upload');
  }
}

main().catch((e) => {
  console.error('Spike A2 fatal:', e);
  process.exit(1);
});
