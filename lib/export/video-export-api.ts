import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentActor, type AuthenticatedActor } from '@/lib/server/auth-context';
import {
  type VideoExportCapability,
  type VideoExportFormat,
  type VideoExportRequestInput,
} from './video-export-contract';

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const createRequestSchema = z
  .object({
    format: z.literal('mp4').optional(),
    sourceRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

export function validateVideoExportIdentifier(value: string) {
  return identifierSchema.safeParse(value);
}

export async function requireVideoExportManager(): Promise<
  { actor: AuthenticatedActor } | { response: NextResponse }
> {
  const actor = await getCurrentActor();
  if (!actor) {
    return {
      response: NextResponse.json(
        { success: false, errorCode: 'UNAUTHENTICATED', error: '请先登录后再使用视频导出。' },
        { status: 401 },
      ),
    };
  }
  if (actor.role !== 'teacher' && actor.role !== 'admin') {
    return {
      response: NextResponse.json(
        { success: false, errorCode: 'FORBIDDEN', error: '仅教师和管理员可以管理视频导出。' },
        { status: 403 },
      ),
    };
  }
  return { actor };
}

export async function parseVideoExportRequest(
  request: NextRequest,
  courseId: string,
  requestedBy: string,
): Promise<{ input: VideoExportRequestInput } | { response: NextResponse }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidVideoExportRequest('请求体必须为 JSON。');
  }
  const parsed = createRequestSchema.safeParse(body);
  if (!parsed.success) {
    return invalidVideoExportRequest('视频导出请求参数无效。');
  }
  return {
    input: {
      courseId,
      requestedBy,
      format: (parsed.data.format ?? 'mp4') as VideoExportFormat,
      sourceRevision: parsed.data.sourceRevision,
    },
  };
}

export function unavailableVideoExportResponse(capability: VideoExportCapability) {
  return NextResponse.json(
    {
      success: false,
      errorCode: capability.code,
      error: capability.message,
      capability,
    },
    { status: 503 },
  );
}

function invalidVideoExportRequest(error: string) {
  return {
    response: NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error },
      { status: 400 },
    ),
  };
}
