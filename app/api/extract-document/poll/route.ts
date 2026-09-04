/**
 * POST /api/extract-document/poll
 *
 * Polls a MinerU Cloud extraction task created by /api/extract-document/start.
 * When the task is done, downloads the result ZIP, parses it, externalizes
 * images to Supabase Storage, and returns the full ParsedPdfContent.
 *
 * Idempotent: re-polling a completed task re-downloads the ZIP but uses
 * upsert semantics on image storage (no duplicate images).
 *
 * Accepts: { batchId, courseId, path }
 * Returns:
 *   - { status: "processing" }   while MinerU is working
 *   - { status: "done", data: ParsedPdfContent }  on completion
 *   - { status: "failed", ... }  on error
 */

import { NextRequest } from 'next/server';
import { getCurrentActor } from '@/lib/server/auth-context';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { externalizeImages, safeApiSuccess } from '@/lib/server/extract-document-shared';
import { parseMinerUZip } from '@/lib/pdf/mineru-cloud';
import { documentArtifactToParsedPdfContent } from '@/lib/document';
import { normalizeDocumentMimeType } from '@/lib/document/mime';

const log = createLogger('ExtractPoll');

const MINERU_BASE = 'https://mineru.net/api/v4';
const POLL_TIMEOUT = 30_000; // 30s per poll request

interface MinerUEnvelope<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

interface BatchResultRow {
  file_name?: string;
  state?: string;
  full_zip_url?: string;
  err_msg?: string;
}

async function readMinerUJson<T>(res: Response, ctx: string): Promise<T> {
  const text = await res.text();
  let json: MinerUEnvelope<T>;
  try {
    json = JSON.parse(text) as MinerUEnvelope<T>;
  } catch {
    throw new Error(`MinerU ${ctx}: invalid JSON (HTTP ${res.status})`);
  }
  if (json.code !== 0) {
    throw new Error(`MinerU ${ctx}: ${json.msg} (code ${json.code})`);
  }
  return json.data;
}

export async function POST(req: NextRequest) {
  try {
    // ── Auth ──
    const actor = await getCurrentActor();
    if (!actor) {
      return apiError('UNAUTHENTICATED', 401, 'Please sign in before extracting materials.');
    }
    const callerUserId = actor.userId;

    // ── Parse body ──
    const body = (await req.json()) as {
      batchId?: string;
      courseId?: string;
      path?: string;
    };
    const { batchId, courseId, path } = body;
    if (!batchId || !courseId || !path) {
      return apiError('MISSING_REQUIRED_FIELD', 400, '请提供 batchId、courseId 和 path');
    }

    // ── Path auth (same as start route) ──
    if (path.includes('..')) {
      return apiError('INVALID_REQUEST', 400, '文件路径非法');
    }
    const pendingMatch = path.match(/^pending\/([^/]+)\//);
    if (pendingMatch && pendingMatch[1] !== callerUserId) {
      return apiError('FORBIDDEN', 403, '无权访问该 pending 文件');
    }

    // ── Get MinerU API key ──
    const mineruKey = process.env.MINERU_CLOUD_API_KEY || process.env.PDF_MINERU_CLOUD_API_KEY;
    if (!mineruKey) {
      return apiError('SERVER_MISCONFIG', 500, 'MinerU Cloud API Key 未配置');
    }

    // ── Poll MinerU batch status ──
    const pollRes = await fetch(
      `${MINERU_BASE}/extract-results/batch/${batchId}`,
      {
        headers: {
          Authorization: `Bearer ${mineruKey}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(POLL_TIMEOUT),
      },
    );

    const pollData = await readMinerUJson<{
      extract_result?: BatchResultRow | BatchResultRow[];
    }>(pollRes, 'extract-results/batch');

    const rows: BatchResultRow[] = Array.isArray(pollData.extract_result)
      ? pollData.extract_result
      : pollData.extract_result
        ? [pollData.extract_result]
        : [];

    const row = rows[0];

    if (!row?.state) {
      // No state yet — MinerU still queueing, treat as processing
      return apiSuccess({
        data: { status: 'processing', batchId },
      });
    }

    // ── Still processing ──
    if (row.state === 'pending' || row.state === 'processing') {
      return apiSuccess({
        data: { status: 'processing', batchId, mineruState: row.state },
      });
    }

    // ── Failed ──
    if (row.state === 'failed') {
      log.error(`MinerU extraction failed: batch_id=${batchId}, err=${row.err_msg}`);
      return apiSuccess({
        data: {
          status: 'failed',
          batchId,
          error: row.err_msg || 'MinerU 解析失败',
        },
      });
    }

    // ── Done: download ZIP, parse, externalize ──
    if (row.state === 'done' && row.full_zip_url) {
      log.info(`MinerU done: batch_id=${batchId}, downloading ZIP...`);

      const parsed = await parseMinerUZip(row.full_zip_url);

      const fileName = path.split('/').pop() || 'document';
      const mimeType = normalizeDocumentMimeType({
        mimeType: 'application/pdf',
        fileName,
      }) || 'application/pdf';

      const { result, stats: uploadStats } = await externalizeImages(parsed, {
        callerUserId,
        extractSessionId: `batch_${batchId}`,
      });

      log.info(
        `Poll-done image externalization: ${uploadStats.total} images, ` +
          `${uploadStats.uploaded} uploaded` +
          (uploadStats.failed > 0 ? `, ${uploadStats.failed} failed` : '') +
          `, ${(uploadStats.totalBytes / 1024 / 1024).toFixed(1)} MB total`,
      );

      // Build output (same shape as legacy route for frontend compatibility)
      const text = result.text || '';
      const output = {
        ...result,
        text,
        metadata: {
          ...result.metadata,
          pageCount: result.metadata?.pageCount ?? 0,
          fileName,
          fileSize: 0,
          mimeType,
          parser: result.metadata?.parser ?? 'mineru-cloud',
        },
      };

      return safeApiSuccess({
        data: { status: 'done', batchId, ...output },
      });
    }

    // Unknown state — treat as processing
    return apiSuccess({
      data: { status: 'processing', batchId, mineruState: row.state },
    });
  } catch (error) {
    log.error('Extract poll failed:', error);
    const msg = error instanceof Error ? error.message : String(error);

    // Distinguish timeout/network errors from parse failures
    if (
      msg.includes('timeout') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('fetch failed')
    ) {
      return apiError(
        'UPSTREAM_ERROR',
        504,
        '解析服务响应超时，请重试轮询',
      );
    }

    return apiError(
      'PARSE_FAILED',
      500,
      msg,
    );
  }
}
