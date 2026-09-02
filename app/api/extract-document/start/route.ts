/**
 * POST /api/extract-document/start
 *
 * Asynchronously starts a MinerU Cloud document extraction task.
 * Returns immediately with a batchId — the file is NOT uploaded through
 * 应用服务器。MinerU 通过短期 COS 读取地址拉取文件。
 *
 * Flow:
 *   1. Auth + path validation (reuse existing pattern)
 *   2. Generate Supabase public URL for the material
 *   3. Call MinerU POST /extract/task/batch with the URL
 *   4. Return { batchId } (< 10s target)
 *
 * The client then polls POST /api/extract-document/poll until done.
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getCurrentActor } from '@/lib/server/auth-context';
import { CosStorage } from '@/lib/server/cos-storage';

const log = createLogger('ExtractStart');

const MINERU_BASE = 'https://mineru.net/api/v4';
const MINERU_START_TIMEOUT = 15_000; // 15s — must return well under Cloudflare 100s

interface MinerUEnvelope<T = unknown> {
  code: number;
  msg: string;
  data: T;
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
      return apiError('UNAUTHENTICATED', 401, '请先登录后再提取材料');
    }
    if (actor.role === 'learner') {
      return apiError('FORBIDDEN', 403, '学员不能发起材料解析');
    }
    const callerUserId = actor.userId;

    // ── Parse body ──
    const body = (await req.json()) as {
      courseId?: string;
      path?: string;
    };
    const { courseId, path } = body;
    if (!courseId || !path) {
      return apiError('MISSING_REQUIRED_FIELD', 400, '请提供 courseId 和 path');
    }

    // ── Path validation (reuse existing semantics) ──
    if (path.includes('..')) {
      return apiError('INVALID_REQUEST', 400, '文件路径非法');
    }
    const pendingMatch = path.match(/^pending\/([^/]+)\//);
    const coursesMatch = path.match(/^courses\/([^/]+)\//);

    // pending/{userId}/... — only the owner can access
    if (pendingMatch) {
      if (pendingMatch[1] !== callerUserId) {
        return apiError('FORBIDDEN', 403, '无权访问该 pending 文件');
      }
    }
    // courses/{courseId}/... — courseId must match
    if (coursesMatch && coursesMatch[1] !== courseId) {
      return apiError('FORBIDDEN', 403, '课程 ID 与路径不匹配');
    }
    // pbl/{projectId}/... — pbl project ID can differ from courseId in path
    // (actual project existence check is in storage layer)

    // ── Verify file exists & get miner-friendly details ──
    const fileName = path.split('/').pop() || 'document';
    // MinerU 只能在短期内读取此文件；课程数据本身不保存该地址。
    const publicUrl = await new CosStorage().getDownloadUrl(path, 900);

    // ── Get MinerU API key ──
    const mineruKey = process.env.MINERU_CLOUD_API_KEY || process.env.PDF_MINERU_CLOUD_API_KEY;
    if (!mineruKey) {
      return apiError('SERVER_MISCONFIG', 500, 'MinerU Cloud API Key 未配置');
    }

    // ── Call MinerU: create URL-mode task ──
    log.info(`Starting async extraction: ${fileName} → MinerU URL mode`);

    const res = await fetch(`${MINERU_BASE}/extract/task/batch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mineruKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: [
          {
            url: publicUrl,
            is_ocr: true,
            data_id: fileName,
          },
        ],
        enable_formula: true,
        enable_table: true,
        model_version: 'vlm',
        language: 'ch',
      }),
      signal: AbortSignal.timeout(MINERU_START_TIMEOUT),
    });

    const taskData = await readMinerUJson<{ batch_id: string }>(res, 'extract/task/batch');

    if (!taskData.batch_id) {
      return apiError('UPSTREAM_ERROR', 500, 'MinerU 未返回 batch_id');
    }

    log.info(`Async extraction started: batch_id=${taskData.batch_id}, file=${fileName}`);

    return apiSuccess({
      data: {
        batchId: taskData.batch_id,
        fileName,
        status: 'started',
      },
    });
  } catch (error) {
    log.error('Extract start failed:', error);
    return apiError('PARSE_FAILED', 500, error instanceof Error ? error.message : '启动解析失败');
  }
}
