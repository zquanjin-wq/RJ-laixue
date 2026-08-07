/**
 * Spike A1 quick test: URL mode with public Supabase URL.
 */
import { createTaskBatch, pollBatch } from './shared';

const PUBLIC_URL = 'https://aqmktsagfvkikehynpdw.supabase.co/storage/v1/object/public/course-assets/spike-test/spike-test-doc.pdf';

async function main() {
  console.log('=== Spike A1 quick: Public URL mode ===\n');
  console.log('URL:', PUBLIC_URL.slice(0, 80) + '...');

  const batch = await createTaskBatch([{ url: PUBLIC_URL, data_id: 'spike-a1-public' }]);
  console.log('batch_id:', batch.batch_id);

  console.log('Polling...');
  const result = await pollBatch(batch.batch_id);
  console.log('✅ SUCCESS!');
  console.log('ZIP URL:', result.full_zip_url?.slice(0, 80) + '...');

  const zipRes = await fetch(result.full_zip_url!);
  const zipBuf = await zipRes.arrayBuffer();
  console.log('ZIP size:', (zipBuf.byteLength / 1024).toFixed(1), 'KB');
  console.log('\n=== Path A1 URL mode: VIABLE ===');
}

main().catch((e) => {
  console.error('❌ Failed:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
