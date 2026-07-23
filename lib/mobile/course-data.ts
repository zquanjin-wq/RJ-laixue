/**
 * lib/mobile/course-data.ts
 *
 * Server-side fetcher for a single course's full data (stage + scenes
 * + outlines). Reuses /api/courses/[id] (which uses service_role and
 * returns the full course JSON).
 *
 * ── SECURITY ─────────────────────────────────────────────────────
 * THIS MODULE IS SERVER-ONLY. It reads `SUPABASE_SERVICE_ROLE_KEY`
 * (admin key, bypasses RLS) to look up courses by id. If this file
 * is ever imported from a 'use client' module, the service_role key
 * will leak into the browser bundle and **anyone can read / mutate
 * the entire courses table**. Keep it server-only.
 *
 * The current call graph (verified 2026-07-23):
 *   - imported by app/m/[id]/page.tsx (RSC, server-only)
 *   - NOT imported by any 'use client' module
 *   - mobile player shell hands the result to MobilePlayer, which is
 *     client-only, but it receives plain JSON (no service_role)
 *
 * If you need to add a new caller, prefer going through
 * /api/courses/[id] (which now does auth + role + assignment check
 * as of 2026-07-23) instead of importing this module directly. That
 * way the call site never sees the service_role key at all.
 */

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Scene } from '@/lib/types/stage';

export interface MobileCourse {
  id: string;
  title: string;
  topic: string;
  created_at: string;
  updated_at: string;
  data: {
    stage: unknown;
    scenes: Scene[];
    outlines: unknown[];
    audioGeneration?: unknown;
  };
  /** Teacher voice config from stage (for TTS fallback on mobile). */
  teacherVoiceConfig?: {
    providerId: string;
    voiceId: string;
    modelId?: string;
  };
}

export async function loadMobileCourse(
  courseId: string,
): Promise<MobileCourse | null> {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(
          cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>,
        ) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options as Parameters<typeof cookieStore.set>[2]),
            );
          } catch {
            // Server component — can't write cookies. Auth refresh is handled
            // by middleware.
          }
        },
      },
    },
  );

  // Identify the signed-in user via cookie session.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Use service_role to bypass RLS. Same pattern as the existing
  // /api/courses/[id] route.
  const { createClient } = await import('@supabase/supabase-js');
  const serviceSupabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await serviceSupabase
    .from('courses')
    .select('id, title, topic, created_at, updated_at, data')
    .eq('id', courseId)
    .maybeSingle();

  if (error || !data) return null;

  // The courses.data column is JSONB with a known shape (stage, scenes,
  // outlines, audioGeneration).
  const courseData = (data.data ?? {}) as MobileCourse['data'];
  const stage = courseData.stage as Record<string, unknown> | undefined;

  // Extract teacherVoiceConfig from stage (set at course creation time,
  // read-only here — we never modify it).
  const tvc = stage?.teacherVoiceConfig as
    | { providerId: string; voiceId: string; modelId?: string }
    | undefined;

  return {
    id: data.id,
    title: data.title,
    topic: data.topic ?? '',
    created_at: data.created_at,
    updated_at: data.updated_at,
    data: {
      stage: courseData.stage,
      scenes: Array.isArray(courseData.scenes) ? courseData.scenes : [],
      outlines: Array.isArray(courseData.outlines) ? courseData.outlines : [],
      audioGeneration: courseData.audioGeneration,
    },
    teacherVoiceConfig: tvc
      ? { providerId: tvc.providerId, voiceId: tvc.voiceId, modelId: tvc.modelId }
      : undefined,
  };
}