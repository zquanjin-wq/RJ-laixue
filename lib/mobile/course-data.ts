/**
 * lib/mobile/course-data.ts
 *
 * Server-side fetcher for a single course's full data (stage + scenes
 * + outlines). Reuses /api/courses/[id] (which uses service_role and
 * returns the full course JSON).
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
  };
}