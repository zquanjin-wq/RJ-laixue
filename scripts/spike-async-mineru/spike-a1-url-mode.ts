/**
 * Spike A1: URL mode — MinerU pulls file from Supabase signed URL.
 *
 * Tests whether MinerU Cloud (domestic servers) can successfully pull and
 * parse a file from a Supabase signed URL. Unlike A2, this path requires
 * no file upload from either browser or Vercel — MinerU fetches the file
 * directly from our Supabase Storage bucket.
 *
 * Critical risk: MinerU docs warn "不支持 GitHub、AWS 等国外 URL" —
 * Supabase is on AWS, but the Supabase project might be in an Asia region.
 * Must verify with real data.
 *
 * Usage:
 *   MINERU_API_KEY=sk-xxx npx tsx scripts/spike-async-mineru/spike-a1-url-mode.ts
 *
 * Prerequisites:
 *   - A PDF file exists in course-assets bucket (we'll find one)
 *   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in .env.local
 */

import { createTaskBatch, pollBatch, authHeader } from './shared';

// These are read from the same .env.local as the Next.js project
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(1);
}

const BUCKET = 'course-assets';
const MINERU_BASE = 'https://mineru.net/api/v4';

async function listMaterialFiles(): Promise<string[]> {
  // List objects in course-assets bucket with pending/ prefix (materials)
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/list/${BUCKET}?prefix=pending/&limit=10`,
    {
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        apikey: SUPABASE_SERVICE_KEY!,
      },
    },
  );
  if (!res.ok) {
    console.error(`   List failed: HTTP ${res.status} — ${await res.text().catch(() => '')}`);
    return [];
  }
  const data = (await res.json()) as Array<{ name: string }>;
  return data
    .filter((f) => f.name.endsWith('.pdf') || f.name.endsWith('.docx') || f.name.endsWith('.pptx'))
    .map((f) => f.name);
}

async function createSignedUrl(path: string, expiresIn = 1800): Promise<string> {
  // Supabase Storage REST API: POST /storage/v1/object/sign/{bucket}/{path}
  const encodedPath = encodeURIComponent(path);
  const url = `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${encodedPath}`;
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn }),
  });
  
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`createSignedUrl failed: HTTP ${res.status} — ${errBody.slice(0, 300)}`);
  }
  
  const data = (await res.json()) as { signedURL?: string; signedUrl?: string };
  let signed = data.signedURL || data.signedUrl;
  if (!signed) {
    throw new Error(`createSignedUrl: no signedURL in response: ${JSON.stringify(data).slice(0, 200)}`);
  }
  // Ensure absolute URL
  if (!signed.startsWith('http')) {
    signed = `${SUPABASE_URL}/storage/v1${signed}`;
  }
  return signed;
}

async function main() {
  console.log('=== Spike A1: MinerU URL mode (Supabase signed URL) ===\n');

  // Step 1: Find a real PDF in storage
  console.log('1. Finding PDF files in course-assets...');
  const files = await listMaterialFiles();
  if (files.length === 0) {
    console.log('   ⚠️  No PDF/DOCX/PPTX files found. Trying direct path...');
    // Fallback: try a known path
    console.log('   Please provide a known file path via FILE_PATH env var');
    if (!process.env.FILE_PATH) {
      console.log('   Set FILE_PATH=path/to/file.pdf and re-run');
      process.exit(0);
    }
    files.push(process.env.FILE_PATH);
  }
  console.log(`   Found ${files.length} files: ${files.slice(0, 5).join(', ')}`);
  const targetPath = files[0];
  console.log(`   Using: ${targetPath}`);

  // Step 2: Generate signed URL (30 min expiry — URL mode needs MinerU to poll, ~3 min)
  console.log('\n2. Generating signed URL (30 min expiry)...');
  const startTime = Date.now();
  const signedUrl = await createSignedUrl(targetPath, 1800);
  console.log(`   Signed URL: ${signedUrl.slice(0, 80)}...`);
  console.log(`   ✅ Generated in ${Date.now() - startTime}ms`);

  // Step 3: Create extract task using URL mode
  console.log('\n3. Creating MinerU task with signed URL...');
  const taskStart = Date.now();
  try {
    const batch = await createTaskBatch([
      { url: signedUrl, data_id: 'spike-a1-test' },
    ]);
    console.log(`   batch_id: ${batch.batch_id}`);
    console.log(`   ✅ Task created in ${Date.now() - taskStart}ms (no file upload needed!)`);

    // Step 4: Poll for completion
    console.log('\n4. Polling for results (waiting for MinerU to pull & parse)...');
    const pollStart = Date.now();
    const result = await pollBatch(batch.batch_id);
    const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
    console.log(`   ✅ Done in ${elapsed}s!`);
    console.log(`   ZIP URL: ${result.full_zip_url?.slice(0, 80)}...`);

    // Step 5: Verify ZIP is accessible
    console.log('\n5. Verifying result ZIP is downloadable...');
    const zipRes = await fetch(result.full_zip_url!);
    if (zipRes.ok) {
      const zipSize = (await zipRes.arrayBuffer()).byteLength;
      console.log(`   ✅ ZIP downloaded: ${(zipSize / 1024).toFixed(1)} KB`);
    } else {
      console.log(`   ❌ ZIP download failed: HTTP ${zipRes.status}`);
    }

    console.log('\n=== Spike A1: SUCCESS ===');
    console.log('Conclusion: MinerU CAN pull files from Supabase signed URLs.');
    console.log('URL mode (Path A1) is viable. No file bytes pass through Vercel.');
  } catch (e) {
    const elapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
    console.error(`\n❌ Failed after ${elapsed}s:`, e instanceof Error ? e.message : String(e));

    // Analyze failure
    const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
    if (msg.includes('timeout') || msg.includes('etimedout')) {
      console.log('\nANALYSIS: MinerU could not pull the file from Supabase URL in time.');
      console.log('         This suggests network restriction between MinerU (domestic) and Supabase (AWS).');
      console.log('         URL mode (Path A1) is NOT viable. Fall back to Path A2.');
    } else if (msg.includes('fetch failed') || msg.includes('econnreset')) {
      console.log('\nANALYSIS: MinerU received the URL but failed to fetch the file.');
      console.log('         Likely network restriction. Path A1 is NOT viable.');
    } else if (msg.includes('failed')) {
      console.log('\nANALYSIS: MinerU explicitly failed. Check err_msg above.');
      console.log('         Path A1 may not be viable.');
    }

    console.log('\n=== Spike A1: FAILED ===');
  }
}

main().catch((e) => {
  console.error('Spike A1 fatal:', e);
  process.exit(1);
});
