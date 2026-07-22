/**
 * app/m/[id]/page.tsx
 *
 * Mobile player page (RSC shell). Authenticates, loads the course
 * data, converts scenes → mobile chapters, and hands off to the
 * client player. If auth fails, redirects to /login?next=.
 */

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getServerSupabase } from '@/lib/supabase/server';
import { loadMobileCourse } from '@/lib/mobile/course-data';
import { buildChapters } from '@/lib/mobile/scene-helpers';
import { MobilePlayer } from './_components/MobilePlayer';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function MobilePlayerPage({ params }: PageProps) {
  const { id } = await params;

  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/m/${id}`)}`);
  }

  const course = await loadMobileCourse(id);
  if (!course) {
    notFound();
  }

  const chapters = buildChapters(course.data.scenes);

  return (
    <main className="min-h-screen flex flex-col">
      {/* Top bar: back to list + course title */}
      <header className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b">
        <div className="mx-auto max-w-md flex items-center gap-3 px-4 py-3">
          <Link
            href="/m"
            className="text-sm text-muted-foreground hover:text-foreground"
            aria-label="返回课程列表"
          >
            ← 返回
          </Link>
          <h1 className="flex-1 text-sm font-medium truncate">
            {course.title || '未命名课件'}
          </h1>
          <span className="text-xs text-muted-foreground shrink-0">
            {chapters.length} 章
          </span>
        </div>
      </header>

      <MobilePlayer
        courseId={course.id}
        courseTitle={course.title || '未命名课件'}
        chapters={chapters}
        teacherVoiceConfig={course.teacherVoiceConfig}
      />
    </main>
  );
}