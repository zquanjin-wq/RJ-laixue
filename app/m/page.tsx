/**
 * app/m/page.tsx
 *
 * Mobile course list (RSC). Server-side auth check + service_role
 * courses fetch — same pattern as /student/courses but rendered as
 * a single-column, mobile-first card list with chapter counts.
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  getServerSupabase,
  getServiceSupabase,
} from '@/lib/supabase/server';
import { Button } from '@/components/ui/button';

interface CourseRow {
  id: string;
  title: string;
  topic: string;
  created_at: string;
  updated_at: string;
}

export default async function MobileCoursesPage() {
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();

  if (!user) {
    redirect('/login?next=/m');
  }

  const serviceSupabase = getServiceSupabase();

  // Admin / teacher accounts get implicit access to all courses per the
  // RJ-laixue policy (no student-row binding required). Mirrors the
  // role check in /student/courses. Without this an admin who tries to
  // preview the learner experience on mobile gets the misleading
  // '还没绑定学员档案' card.
  const { data: callerProfile } = await serviceSupabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  const isStaff = callerProfile?.role === 'admin' || callerProfile?.role === 'teacher';

  // Confirm the user has a student row (matches /student/courses policy:
  // only learners need to bind; staff skip this check).
  const { data: student } = isStaff
    ? { data: null }
    : await serviceSupabase
        .from('students')
        .select('id, name, disabled_at')
        .eq('user_id', user.id)
        .maybeSingle();

  if (!isStaff && !student) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-sm text-center space-y-3">
          <h1 className="text-lg font-semibold">还没有学员档案</h1>
          <p className="text-sm text-muted-foreground">
            账号 {user.email} 还没有关联学员档案，请使用老师发的 /invite?code=XXXXXX 邀请链接绑定后即可查看分配的课程。
          </p>
        </div>
      </main>
    );
  }

  if (!isStaff && student?.disabled_at) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-sm text-center space-y-3">
          <h1 className="text-lg font-semibold">账号已停用</h1>
          <p className="text-sm text-muted-foreground">
            你的账号已被管理员停用。如需恢复请联系培训管理员。
          </p>
        </div>
      </main>
    );
  }

  // Fetch all active courses (everyone sees everything during pilot)
  const { data: coursesData } = await serviceSupabase
    .from('courses')
    .select('id, title, topic, created_at, updated_at')
    .order('updated_at', { ascending: false });

  const courses = (coursesData ?? []) as CourseRow[];

  return (
    <main className="min-h-screen px-4 pt-6 pb-10">
      <header className="mx-auto max-w-md mb-6">
        <h1 className="text-xl font-semibold tracking-tight">
          欢迎，{isStaff ? (user.email?.split('@')[0] || '管理员') : (student?.name || '同学')}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isStaff ? '管理员视角 · ' : ''}下方为所有已发布课件
        </p>
      </header>

      <div className="mx-auto max-w-md space-y-3">
        {courses.length === 0 && (
          <div className="text-center py-12 text-sm text-muted-foreground">
            暂无课件。管理员发布后会显示在这里。
          </div>
        )}

        {courses.map((c) => (
          <Link
            key={c.id}
            href={`/m/${c.id}`}
            className="block rounded-lg border bg-card p-4 transition-colors hover:bg-accent"
          >
            <h2 className="text-base font-medium leading-snug">
              {c.title || '未命名课件'}
            </h2>
            {c.topic && (
              <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
                {c.topic}
              </p>
            )}
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                更新于 {new Date(c.updated_at).toLocaleDateString('zh-CN')}
              </span>
              <Button size="sm" variant="default" className="h-8 px-3 text-xs">
                开始学习 →
              </Button>
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}