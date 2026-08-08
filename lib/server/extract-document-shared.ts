/**
 * lib/server/extract-document-shared.ts
 *
 * Shared helpers for document extraction routes:
 *   - externalizeImages: base64 → Supabase Storage (from 20ed5ddf)
 *   - safeApiSuccess: response body size assertion (< 4MB)
 *
 * Used by:
 *   - app/api/extract-document/route.ts (existing sync path)
 *   - app/api/extract-document/poll/route.ts (new async poll)
 */

import { NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { getServiceSupabase } from '@/lib/supabase/server';
import { COURSE_ASSET_BUCKET } from '@/lib/course-assets/shared';
import { apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('ExtractDocShared');

// ── Image externalization ─────────────────────────────────────────────────────

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface ExternalizeOptions {
  callerUserId: string;
  extractSessionId?: string;
}

export interface ExternalizeStats {
  total: number;
  uploaded: number;
  failed: number;
  totalBytes: number;
}

export interface ExternalizeResult {
  result: ParsedPdfContent;
  stats: ExternalizeStats;
}

/**
 * Upload base64-inline images to Supabase course-assets bucket.
 * Response carries storagePath/publicUrl references instead of base64 src.
 *
 * Single-image failure → marks missing, does NOT abort the extraction.
 * (Matches frontend storeImages single-failure tolerance.)
 */
export async function externalizeImages(
  parsed: ParsedPdfContent,
  opts: ExternalizeOptions,
): Promise<ExternalizeResult> {
  const sessionId = opts.extractSessionId ?? nanoid(12);
  const pdfImages = parsed.metadata?.pdfImages;
  const stats: ExternalizeStats = { total: 0, uploaded: 0, failed: 0, totalBytes: 0 };

  if (!pdfImages || pdfImages.length === 0) {
    return {
      result: {
        ...parsed,
        images: [],
        metadata: {
          ...parsed.metadata,
          pageCount: parsed.metadata?.pageCount ?? 0,
          imageMapping: {},
          pdfImages: [],
        },
      },
      stats,
    };
  }

  const service = getServiceSupabase();
  const pathPrefix = `pending/${opts.callerUserId}/images/${sessionId}`;

  const externalizedPdfImages = await Promise.all(
    pdfImages.map(async (img) => {
      if (!img.src || !img.src.startsWith('data:')) {
        return img;
      }

      stats.total++;
      const commaIdx = img.src.indexOf(',');
      if (commaIdx === -1) {
        stats.failed++;
        return { ...img, src: '', missing: true };
      }

      const header = img.src.slice(5, commaIdx);
      const mimeType = header.split(';')[0] || 'image/png';
      const base64 = img.src.slice(commaIdx + 1);
      const ext = MIME_TO_EXT[mimeType] || 'png';
      const storagePath = `${pathPrefix}/${img.id}.${ext}`;

      try {
        const buffer = Buffer.from(base64, 'base64');
        stats.totalBytes += buffer.length;

        const { error } = await service.storage
          .from(COURSE_ASSET_BUCKET)
          .upload(storagePath, buffer, {
            contentType: mimeType,
            upsert: true,
          });

        if (error) {
          log.error(`Image upload failed [${img.id} → ${storagePath}]:`, error.message);
          stats.failed++;
          return { ...img, src: '', storagePath, missing: true };
        }

        const { data: publicData } = service.storage
          .from(COURSE_ASSET_BUCKET)
          .getPublicUrl(storagePath);

        stats.uploaded++;
        return { ...img, src: '', storagePath, publicUrl: publicData.publicUrl };
      } catch (e) {
        log.error(`Image upload exception [${img.id} → ${storagePath}]:`, e);
        stats.failed++;
        return { ...img, src: '', storagePath, missing: true };
      }
    }),
  );

  return {
    result: {
      ...parsed,
      images: [],
      metadata: {
        ...parsed.metadata,
        pageCount: parsed.metadata?.pageCount ?? 0,
        imageMapping: {},
        pdfImages: externalizedPdfImages,
      },
    },
    stats,
  };
}

// ── Response size assertion ───────────────────────────────────────────────────

/** Vercel Functions response limit 4.5 MB; 0.5 MB margin for safety */
export const RESPONSE_MAX_BYTES = 4 * 1024 * 1024; // 4 MB

/**
 * Same semantics as apiSuccess, but serializes JSON and asserts < RESPONSE_MAX_BYTES
 * before returning. Over-limit → structured error instead of letting Vercel platform
 * replace the 200 with a non-JSON error page.
 */
export function safeApiSuccess<T extends Record<string, unknown>>(data: T): NextResponse {
  const bodyString = JSON.stringify({ success: true, ...data });
  const bodyBytes = Buffer.byteLength(bodyString, 'utf-8');
  log.info(
    `Response body size: ${bodyBytes} bytes (${(bodyBytes / 1024 / 1024).toFixed(2)} MB)` +
      ` / limit ${RESPONSE_MAX_BYTES} bytes`,
  );

  if (bodyBytes > RESPONSE_MAX_BYTES) {
    log.error(
      `Response body ${bodyBytes} bytes exceeds ${RESPONSE_MAX_BYTES} bytes limit ` +
        `(${(bodyBytes / 1024 / 1024).toFixed(1)} MB > ${(RESPONSE_MAX_BYTES / 1024 / 1024).toFixed(1)} MB)`,
    );
    return apiError(
      'PARSE_FAILED',
      500,
      `解析结果过大 (${(bodyBytes / 1024 / 1024).toFixed(1)} MB)，请拆分材料后重试`,
    );
  }

  return NextResponse.json({ success: true, ...data }, { status: 200 });
}
