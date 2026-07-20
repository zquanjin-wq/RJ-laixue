import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const BUCKET_NAME = 'course-audio';

function stringifyDetails(details: unknown) {
  if (!details) return undefined;
  if (typeof details === 'string') return details;
  if (details instanceof Error) return details.message;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function getFileExtension(fileName: string, fallback = 'mp3') {
  const parts = fileName.split('.');
  const ext = parts.length > 1 ? parts.pop() : '';
  return ext || fallback;
}

function sanitizeFileName(fileName: string) {
  return fileName
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .toLowerCase();
}

function sanitizePathPart(value: string) {
  return value
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .toLowerCase();
}

function getAudioContentType(ext: string, fallback?: string) {
  if (fallback?.startsWith('audio/')) return fallback;

  const normalized = ext.toLowerCase();

  if (normalized === 'mp3' || normalized === 'mpeg') return 'audio/mpeg';
  if (normalized === 'wav') return 'audio/wav';
  if (normalized === 'ogg') return 'audio/ogg';
  if (normalized === 'webm') return 'audio/webm';
  if (normalized === 'm4a') return 'audio/mp4';

  return `audio/${normalized || 'mpeg'}`;
}

async function ensureAudioBucket(supabase: ReturnType<typeof createClient>) {
  const { error: getError } = await supabase.storage.getBucket(BUCKET_NAME);
  if (!getError) return;

  const { error: createError } = await supabase.storage.createBucket(BUCKET_NAME, {
    public: true,
    fileSizeLimit: '50MB',
    allowedMimeTypes: [
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/ogg',
      'audio/webm',
      'audio/mp4',
    ],
  });

  if (createError) {
    throw new Error(`Storage bucket "${BUCKET_NAME}" is not available: ${createError.message}`);
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json(
        {
          error: 'Missing Supabase env vars',
          details: {
            hasSupabaseUrl: Boolean(supabaseUrl),
            hasServiceRoleKey: Boolean(serviceRoleKey),
          },
        },
        { status: 500 },
      );
    }

    const formData = await request.formData();
    const file = formData.get('file');
    const stageIdValue = formData.get('stageId');
    const audioIdValue = formData.get('audioId');

    const stageId =
      typeof stageIdValue === 'string' ? sanitizePathPart(stageIdValue) : '';
    const audioId =
      typeof audioIdValue === 'string' ? sanitizePathPart(audioIdValue) : '';

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: 'Missing audio file. Please upload with form field name "file".' },
        { status: 400 },
      );
    }

    if (!file.type.startsWith('audio/')) {
      return NextResponse.json(
        { error: `Invalid file type: ${file.type || 'unknown'}` },
        { status: 400 },
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const ext = getFileExtension(file.name);
    const safeName = sanitizeFileName(file.name) || `audio.${ext}`;

    const filePath =
      stageId && audioId
        ? `classrooms/${stageId}/audio/${audioId}.${ext}`
        : `uploads/${Date.now()}-${crypto.randomUUID()}-${safeName}`;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filePath, buffer, {
        contentType: getAudioContentType(ext, file.type),
        upsert: Boolean(stageId && audioId),
      });

    if (uploadError) {
      return NextResponse.json(
        {
          error: 'Failed to upload audio to Supabase Storage',
          details: uploadError.message,
        },
        { status: 500 },
      );
    }

    const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(filePath);

    return NextResponse.json({
      url: data.publicUrl,
      path: filePath,
      bucket: BUCKET_NAME,
      fileName: file.name,
      contentType: file.type,
      size: file.size,
      stageId: stageId || undefined,
      audioId: audioId || undefined,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Unexpected audio upload error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
